import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import * as algokit from '@algorandfoundation/algokit-utils';
import algosdk, { Algodv2, makeBasicAccountTransactionSigner, makePaymentTxnWithSuggestedParamsFromObject } from 'algosdk'; import { AbstractedAccountClient } from '../contracts/clients/AbstractedAccountClient';
import { RecoveryPluginClient } from '../contracts/clients/RecoveryPluginClient';
import { microAlgos, transferAlgos } from '@algorandfoundation/algokit-utils';

const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const fixture = algorandFixture();

describe('Abstracted Account Program', () => {
  let algod: Algodv2;
  /** Alice's externally owned account (ie. a keypair account she has in Defly) */
  let aliceEOA: algosdk.Account;
  /** The address of Alice's new abstracted account. Sends app calls from aliceEOA unless otherwise specified */
  let aliceAbstractedAccount: string;
  /** The client for Alice's abstracted account */
  let abstractedAccountClient: AbstractedAccountClient;
  /** The client for the recovery plugin */
  let recoveryPluginClient: RecoveryPluginClient;
  /** The ID of the abstracted account app */
  let abstractedAccountAppID: number;
  /** The ID of the recovery plugin */
  let recoveryPluginID: number;
  /** The suggested params for transactions */
  let suggestedParams: algosdk.SuggestedParams;
  /** The account that can initiate recovery */
  let recoveryAccount: algosdk.Account;
  /** The number of grace rounds */
  let graceRounds: uint64;

  /** The maximum uint64 value. Used to indicate a never-expiring plugin */
  const maxUint64 = BigInt('18446744073709551615');

  beforeEach(fixture.beforeEach);

  beforeAll(async () => {
    await fixture.beforeEach();
    algod = fixture.context.algod;
    suggestedParams = await algod.getTransactionParams().do();
    aliceEOA = await fixture.context.generateAccount({ initialFunds: microAlgos(1_000_000) });;
    recoveryAccount = await fixture.context.generateAccount({ initialFunds: microAlgos(1_000_000) });
    console.log("Alice's account: " + aliceEOA.addr);
    console.log("Recovery account: " + recoveryAccount.addr);

    abstractedAccountClient = new AbstractedAccountClient(
      {
        sender: aliceEOA,
        resolveBy: 'id',
        id: 0,
      },
      algod
    );

    // Create an abstracted account app
    await abstractedAccountClient.create.createApplication({
      // Set address to ZERO_ADDRESS so the app address is used
      controlledAddress: ZERO_ADDRESS,
      // aliceEOA will be the admin
      admin: aliceEOA.addr,
    });

    aliceAbstractedAccount = (await abstractedAccountClient.appClient.getAppReference()).appAddress;
    abstractedAccountAppID = Number((await abstractedAccountClient.appClient.getAppReference()).appId);
    console.log("Abstracted account: " + aliceAbstractedAccount);

    // Fund the abstracted account with 0.1 ALGO for MBR
    await abstractedAccountClient.appClient.fundAppAccount({ amount: algokit.microAlgos(100_000) });

    // Deploy the recovery plugin
    graceRounds = 3;
    recoveryPluginClient = new RecoveryPluginClient(
      {
        sender: recoveryAccount,
        resolveBy: 'id',
        id: 0,
      },
      algod
    );
    await recoveryPluginClient.create.createApplication({
      controlledAccount: aliceAbstractedAccount,
      recoveryAccount: recoveryAccount.addr,
      graceRounds,
    });
    recoveryPluginID = Number((await recoveryPluginClient.appClient.getAppReference()).appId);
  });


  describe('Successful recovery with recovery plugin', () => {
    /** The boxes to pass to app calls */
    let boxes: Uint8Array[];

    beforeAll(() => {
      /** The box key for a plugin is `p + plugin ID + allowed caller`  */
      let pluginBox1 = new Uint8Array(
        Buffer.concat([
          Buffer.from('p'),
          Buffer.from(algosdk.encodeUint64(recoveryPluginID)),
          algosdk.decodeAddress(recoveryAccount.addr).publicKey,
        ])
      );
      let pluginBox2 = new Uint8Array(
        Buffer.concat([
          Buffer.from('p'),
          Buffer.from(algosdk.encodeUint64(recoveryPluginID)),
          algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
        ])
      );
      boxes = [pluginBox1, pluginBox2];
    });

    test('Alice adds the recovery app to the abstracted account', async () => {
      await abstractedAccountClient.appClient.fundAppAccount({ amount: algokit.microAlgos(22100) });
      await abstractedAccountClient.arc58AddPlugin(
        {
          // Add the subscription plugin
          app: recoveryPluginID,
          // Set address to ZERO_ADDRESS so anyone can call it
          allowedCaller: recoveryAccount.addr,
          // Set end to maxUint64 so it never expires
          end: maxUint64,
        },
        { boxes }
      );
    });

    test('Recovery account calls the program to trigger recovery', async () => {
      // Recovery account initializes recovery
      await recoveryPluginClient
        .compose()
        .initiateRecovery({}, {})
        .execute();

      // make sure that the round progresses a bit
      for (let i = 0; i < graceRounds + 1; i++) {
        await transferAlgos({
          from: aliceEOA,
          to: aliceEOA,
          amount: microAlgos(0)
        }, algod);
      }

      // transaction that calls the recovery plugin
      let recoveryTxn = (await recoveryPluginClient
        .compose()
        .recover({
          abstractedAccountApp: abstractedAccountAppID,
          controlledAccount: aliceAbstractedAccount
        }, {
          sender: recoveryAccount,
          sendParams: { fee: algokit.microAlgos(3_000) },
        }).atc()).buildGroup()[0];

      // Compose the group needed to actually use the plugin
      await abstractedAccountClient
        .compose()
        // Step one: rekey to the plugin
        .arc58RekeyToPlugin(
          { plugin: recoveryPluginID },
          {
            sender: recoveryAccount,
            boxes,
            sendParams: { fee: algokit.microAlgos(2_000) },
          }
        )
        // Step two: Call the plugin
        .addTransaction(recoveryTxn)
        // Step three: Call verify auth addr to rekey back to the abstracted account
        .arc58VerifyAuthAddr({})
        .execute();
    });

    test('Recovery account changes admin account back to Alice', async () => {
      // Compose the group needed to actually use the plugin
      await abstractedAccountClient
        .compose()
        // Step one: rekey to the plugin
        .arc58ChangeAdmin(
          { newAdmin: aliceEOA.addr },
          { sender: recoveryAccount },
        )
        .execute();
    });
  });


  describe('Alice aborts recovery with recovery plugin', () => {
    /** The boxes to pass to app calls */
    let boxes: Uint8Array[];

    beforeAll(async () => {
      /** The box key for a plugin is `p + plugin ID + allowed caller`  */
      let pluginBox1 = new Uint8Array(
        Buffer.concat([
          Buffer.from('p'),
          Buffer.from(algosdk.encodeUint64(recoveryPluginID)),
          algosdk.decodeAddress(recoveryAccount.addr).publicKey,
        ])
      );
      let pluginBox2 = new Uint8Array(
        Buffer.concat([
          Buffer.from('p'),
          Buffer.from(algosdk.encodeUint64(recoveryPluginID)),
          algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
        ])
      );
      boxes = [pluginBox1, pluginBox2];
    });

    test('Alice aborts recovery', async () => {
      // Recovery account initializes recovery
      await recoveryPluginClient
        .compose()
        .initiateRecovery({}, {})
        .execute();

      // Alice aborts the recovery
      await abstractedAccountClient
        .compose()
        // Step one: rekey abstracted account to Alice
        .arc58RekeyTo(
          { addr: aliceEOA.addr, flash: true },
          {
            sender: aliceEOA,
            sendParams: {
              // 2000 for this txn, 1000 for next txn, 1000 for last txn
              fee: microAlgos(4000)
            },
          }
        )
        // Step two: abort recovery from abstracted account
        .addTransaction((await recoveryPluginClient
          .compose()
          .abortRecovery({}, {
            sender: {
              addr: aliceAbstractedAccount,
              signer: makeBasicAccountTransactionSigner(aliceEOA),
            },
            sendParams: { fee: microAlgos(0) },
          })
          .atc()).buildGroup()[0]
        )
        // Step three: rekey abstracted account back to itself
        .addTransaction({
          txn: makePaymentTxnWithSuggestedParamsFromObject({
            from: aliceAbstractedAccount,
            to: aliceAbstractedAccount,
            rekeyTo: aliceAbstractedAccount,
            amount: 0,
            suggestedParams: { ...suggestedParams, fee: 0, flatFee: true },
          }),
          signer: makeBasicAccountTransactionSigner(aliceEOA)
        })
        .execute();

      // make sure that the round progresses a bit
      for (let i = 0; i < graceRounds + 1; i++) {
        await transferAlgos({
          from: aliceEOA,
          to: aliceEOA,
          amount: microAlgos(0)
        }, algod);
      }

      // Recovery account attempts to finalize recovery, but fails
      await expect(abstractedAccountClient
        .compose()
        // Step one: rekey to the plugin
        .arc58RekeyToPlugin(
          { plugin: recoveryPluginID },
          {
            sender: recoveryAccount,
            boxes,
            sendParams: { fee: algokit.microAlgos(2_000) },
          }
        )
        // Step two: call plugin to finalize recovery
        .addTransaction((await recoveryPluginClient
          .compose()
          .recover({
            abstractedAccountApp: abstractedAccountAppID,
            controlledAccount: aliceAbstractedAccount
          }, {
            sender: recoveryAccount,
            sendParams: { fee: algokit.microAlgos(3_000) },
          }).atc()).buildGroup()[0]
        )
        // Step three: Call verify auth addr to rekey back to the abstracted account
        .arc58VerifyAuthAddr({})
        .execute()
      ).rejects.toThrowError();
    });
  });


  describe('Unauthorized recovery', () => {
    /** The boxes to pass to app calls */
    let boxes: Uint8Array[];

    beforeAll(() => {
      /** The box key for a plugin is `p + plugin ID + allowed caller`  */
      let pluginBox1 = new Uint8Array(
        Buffer.concat([
          Buffer.from('p'),
          Buffer.from(algosdk.encodeUint64(recoveryPluginID)),
          algosdk.decodeAddress(recoveryAccount.addr).publicKey,
        ])
      );
      let pluginBox2 = new Uint8Array(
        Buffer.concat([
          Buffer.from('p'),
          Buffer.from(algosdk.encodeUint64(recoveryPluginID)),
          algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
        ])
      );
      boxes = [pluginBox1, pluginBox2];
    });

    test('Recovery account cannot call recover without initiating recovery first ', async () => {
      // Recovery account attempts to finalize recovery, but fails
      await expect(abstractedAccountClient
        .compose()
        // Step one: rekey to the plugin
        .arc58RekeyToPlugin(
          { plugin: recoveryPluginID },
          {
            sender: recoveryAccount,
            boxes,
            sendParams: { fee: algokit.microAlgos(2_000) },
          }
        )
        // Step two: call plugin to finalize recovery
        .addTransaction((await recoveryPluginClient
          .compose()
          .recover({
            abstractedAccountApp: abstractedAccountAppID,
            controlledAccount: aliceAbstractedAccount
          }, {
            sender: recoveryAccount,
            sendParams: { fee: algokit.microAlgos(3_000) },
          }).atc()).buildGroup()[0]
        )
        // Step three: Call verify auth addr to rekey back to the abstracted account
        .arc58VerifyAuthAddr({})
        .execute()
      ).rejects.toThrowError();
    });

    test('Attacker cannot call initiate_recovery', async () => {
      let attacker = await fixture.context.generateAccount({ initialFunds: microAlgos(1_000_000) });;
      await expect(recoveryPluginClient
        .compose()
        .initiateRecovery({}, { sender: attacker })
        .execute()
      ).rejects.toThrowError();
    });
  });
});
