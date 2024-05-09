import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import * as algokit from '@algorandfoundation/algokit-utils';
import algosdk, { Algodv2, makeBasicAccountTransactionSigner, makePaymentTxnWithSuggestedParamsFromObject } from 'algosdk'; import { AbstractedAccountClient } from '../contracts/clients/AbstractedAccountClient';
import { SpendingLimitPluginClient } from '../contracts/clients/SpendingLimitPluginClient';
import { microAlgos } from '@algorandfoundation/algokit-utils';

const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const ALOG_ID = 0;
const SPENDING_LIMIT_MBR = 28900;
const fixture = algorandFixture();

describe('Spending Limit Plugin Program', () => {
  let algod: Algodv2;
  /** Alice's externally owned account (ie. a keypair account she has in Defly) */
  let aliceEOA: algosdk.Account;
  /** The address of Alice's new abstracted account. Sends app calls from aliceEOA unless otherwise specified */
  let aliceAbstractedAccount: string;
  /** The client for Alice's abstracted account */
  let abstractedAccountClient: AbstractedAccountClient;
  /** The client for the recovery plugin */
  let spendingLimitPluginClient: SpendingLimitPluginClient;
  /** The ID of the abstracted account app */
  let abstractedAccountAppID: number;
  /** The ID of the recovery plugin */
  let spendingLimitPluginID: number;
  /** The suggested params for transactions */
  let suggestedParams: algosdk.SuggestedParams;
  /** The granularity in seconds in which spendings are tracked */
  let timePeriodSec: number;
  /** Accounts that are allowed to spend from the abstracted account */
  let spendingAccount1: algosdk.Account;
  let spendingAccount2: algosdk.Account;
  /** The ID of a test asset */
  let asset: number;
  /** The number of seconds between blocks in devmode */
  let blockOffsetTimestamp: number;
  /** The maximum uint64 value. Used to indicate a never-expiring plugin */
  const maxUint64 = BigInt('18446744073709551615');

  beforeEach(fixture.beforeEach);

  async function currentLedgerTime() {
    let currentRound = (await algod.getTransactionParams().do()).firstRound;
    return (await algod.block(currentRound).do()).block.ts;
  }

  async function progressLedgerTimeUntil(until: number) {
    while (await currentLedgerTime() < until) {
      let params = await algod.getTransactionParams().do();
      await algod.sendRawTransaction(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        from: fixture.context.testAccount.addr,
        to: fixture.context.testAccount.addr,
        amount: 0,
        suggestedParams: { ...params, fee: 1000, flatFee: true },
      }).signTxn(fixture.context.testAccount.sk)).do();
    }
  }

  beforeAll(async () => {
    await fixture.beforeEach();
    algod = fixture.context.algod;
    suggestedParams = await algod.getTransactionParams().do();
    aliceEOA = await fixture.context.generateAccount({ initialFunds: microAlgos(100_000_000) });;
    console.log(`alice EOA: ${aliceEOA.addr}`);

    // spending limits apply to a 60-minute period (configurable). We make sure
    // that the block time is less than that
    timePeriodSec = 60 * 60;
    await algod.setBlockOffsetTimestamp(60).do();

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

    // fund the spending accounts
    spendingAccount1 = await fixture.context.generateAccount({ initialFunds: microAlgos(1_000_000) });
    spendingAccount2 = await fixture.context.generateAccount({ initialFunds: microAlgos(1_000_000) });
    console.log(`spendingAccount1: ${spendingAccount1.addr}`);
    console.log(`spendingAccount2: ${spendingAccount2.addr}`);

    // Deploy the spending-limit plugin
    spendingLimitPluginClient = new SpendingLimitPluginClient(
      {
        sender: aliceEOA,
        resolveBy: 'id',
        id: 0,
      },
      algod
    );
    await spendingLimitPluginClient.create.createApplication({
      abstractedAccountApp: abstractedAccountAppID,
      timePeriod: timePeriodSec,
    });
    await spendingLimitPluginClient.appClient.fundAppAccount({ amount: algokit.microAlgos(100_000) });
    spendingLimitPluginID = Number((await spendingLimitPluginClient.appClient.getAppReference()).appId);

    // Register spending-limit plugin
    let boxes = [new Uint8Array(
      Buffer.concat([
        Buffer.from('p'),
        Buffer.from(algosdk.encodeUint64(spendingLimitPluginID)),
        algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
      ])
    )];
    await abstractedAccountClient.appClient.fundAppAccount({ amount: algokit.microAlgos(22100) });
    await abstractedAccountClient.arc58AddPlugin(
      {
        app: spendingLimitPluginID,
        allowedCaller: ZERO_ADDRESS,
        end: maxUint64,
      },
      { boxes }
    );

    // Fund the abstracted account with some ALGO to later spend
    await abstractedAccountClient.appClient.fundAppAccount({ amount: algokit.microAlgos(50_000_000) });

    // Create an asset
    const assetCreateTxn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
      from: aliceEOA.addr,
      total: 1_000_000_000,
      decimals: 0,
      defaultFrozen: false,
      suggestedParams,
    });
    const txn = await algokit.sendTransaction({ transaction: assetCreateTxn, from: aliceEOA }, algod);
    asset = Number(txn.confirmation!.assetIndex!);

    // Opt abstracted account into asset
    await abstractedAccountClient
      .compose()
      // Step one: rekey abstracted account to Alice
      .arc58RekeyTo(
        { addr: aliceEOA.addr, flash: true },
        {
          sender: aliceEOA,
          sendParams: {
            // 2000 for this txn, 4000 for following txn
            fee: microAlgos(6000)
          },
        }
      )
      // Step two: fund abstracted account with MBR for asset
      .addTransaction({
        txn: algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          from: aliceEOA.addr,
          to: aliceAbstractedAccount,
          amount: 100_000,
          suggestedParams: { ...suggestedParams, fee: 0, flatFee: true },
        }),
        signer: makeBasicAccountTransactionSigner(aliceEOA)
      })
      // Step three: opt abstracted account into asset
      .addTransaction({
        txn: algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          from: aliceAbstractedAccount,
          to: aliceAbstractedAccount,
          amount: 0,
          assetIndex: asset,
          suggestedParams: { ...suggestedParams, fee: 0, flatFee: true },
        }),
        signer: makeBasicAccountTransactionSigner(aliceEOA)
      })
      // Step four: send asset
      .addTransaction({
        txn: algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
          from: aliceEOA.addr,
          to: aliceAbstractedAccount,
          amount: 1_000_000_000,
          assetIndex: asset,
          suggestedParams: { ...suggestedParams, fee: 0, flatFee: true },
        }),
        signer: makeBasicAccountTransactionSigner(aliceEOA)
      })
      // Step five: rekey abstracted account back to itself
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

    // Opt spending account into asset
    await algod.sendRawTransaction(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      from: spendingAccount1.addr,
      to: spendingAccount1.addr,
      amount: 0,
      assetIndex: asset,
      suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
    }).signTxn(spendingAccount1.sk)).do();

    // Log abstracted account state after setup is complete
    console.log(await algod.accountInformation(aliceAbstractedAccount).do());
  });


  describe('spendingAccount1 spends from abstracted account', () => {
    test('Alice sets ALGO spending limit for spendingAccount1', async () => {
      await spendingLimitPluginClient.appClient.fundAppAccount({
        amount: algokit.microAlgos(SPENDING_LIMIT_MBR)
      });
      await spendingLimitPluginClient
        .compose()
        .setSpendingLimit({
          account: spendingAccount1.addr,
          assetId: ALOG_ID,
          limit: 5_000_000,
        }, {
          sender: aliceEOA,
          apps: [abstractedAccountAppID],
          boxes: [
            new Uint8Array(
              Buffer.concat([
                Buffer.from('sl'),
                algosdk.decodeAddress(spendingAccount1.addr).publicKey,
                Buffer.from(algosdk.encodeUint64(ALOG_ID)),
              ])
            )
          ]
        })
        .execute();
    });

    test('spendingAccount1 spends ALGO', async () => {
      await abstractedAccountClient
        .compose()
        // Step one: rekey to the plugin
        .arc58RekeyToPlugin(
          { plugin: spendingLimitPluginID },
          {
            sender: spendingAccount1,
            sendParams: { fee: algokit.microAlgos(4_000) },
            boxes: [new Uint8Array(
              Buffer.concat([
                Buffer.from('p'),
                Buffer.from(algosdk.encodeUint64(spendingLimitPluginID)),
                algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
              ]),
            )],
          }
        )
        // Step two: Call the plugin
        .addTransaction((await spendingLimitPluginClient
          .compose()
          .spend({
            controlledAccount: aliceAbstractedAccount,
            receiver: spendingAccount1.addr,
            assetId: ALOG_ID,
            amount: 1_000_000,
          }, {
            sender: spendingAccount1,
            apps: [abstractedAccountAppID],
            boxes: [
              new Uint8Array(
                Buffer.concat([
                  Buffer.from('sl'),
                  algosdk.decodeAddress(spendingAccount1.addr).publicKey,
                  Buffer.from(algosdk.encodeUint64(ALOG_ID)),
                ])
              )
            ],
            sendParams: { fee: algokit.microAlgos(0) },
          }).atc()).buildGroup()[0]
        )
        // Step three: Call verify auth addr to rekey back to the abstracted account
        .arc58VerifyAuthAddr({})
        .execute();
    });

    test('spendingAccount1 tries to overspend ALGO limit, fails', async () => {
      await expect(abstractedAccountClient
        .compose()
        // Step one: rekey to the plugin
        .arc58RekeyToPlugin(
          { plugin: spendingLimitPluginID },
          {
            sender: spendingAccount1,
            sendParams: { fee: algokit.microAlgos(4_000) },
            boxes: [new Uint8Array(
              Buffer.concat([
                Buffer.from('p'),
                Buffer.from(algosdk.encodeUint64(spendingLimitPluginID)),
                algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
              ]),
            )],
          }
        )
        // Step two: Call the plugin
        .addTransaction((await spendingLimitPluginClient
          .compose()
          .spend({
            controlledAccount: aliceAbstractedAccount,
            receiver: spendingAccount1.addr,
            assetId: ALOG_ID,
            amount: 4_500_000,
          }, {
            sender: spendingAccount1,
            apps: [abstractedAccountAppID],
            boxes: [
              new Uint8Array(
                Buffer.concat([
                  Buffer.from('sl'),
                  algosdk.decodeAddress(spendingAccount1.addr).publicKey,
                  Buffer.from(algosdk.encodeUint64(ALOG_ID)),
                ])
              )
            ],
            sendParams: { fee: algokit.microAlgos(0) },
          }).atc()).buildGroup()[0]
        )
        // Step three: Call verify auth addr to rekey back to the abstracted account
        .arc58VerifyAuthAddr({})
        .execute()
      ).rejects.toThrowError();
    });

    test('spendingAccount1 can now spend ALGO after time has passed', async () => {
      await progressLedgerTimeUntil((await currentLedgerTime()) + timePeriodSec);
      await abstractedAccountClient
        .compose()
        // Step one: rekey to the plugin
        .arc58RekeyToPlugin(
          { plugin: spendingLimitPluginID },
          {
            sender: spendingAccount1,
            sendParams: { fee: algokit.microAlgos(4_000) },
            boxes: [new Uint8Array(
              Buffer.concat([
                Buffer.from('p'),
                Buffer.from(algosdk.encodeUint64(spendingLimitPluginID)),
                algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
              ]),
            )],
          }
        )
        // Step two: Call the plugin
        .addTransaction((await spendingLimitPluginClient
          .compose()
          .spend({
            controlledAccount: aliceAbstractedAccount,
            receiver: spendingAccount1.addr,
            assetId: ALOG_ID,
            amount: 4_500_000,
          }, {
            sender: spendingAccount1,
            apps: [abstractedAccountAppID],
            boxes: [
              new Uint8Array(
                Buffer.concat([
                  Buffer.from('sl'),
                  algosdk.decodeAddress(spendingAccount1.addr).publicKey,
                  Buffer.from(algosdk.encodeUint64(ALOG_ID)),
                ])
              )
            ],
            sendParams: { fee: algokit.microAlgos(0) },
          }).atc()).buildGroup()[0]
        )
        // Step three: Call verify auth addr to rekey back to the abstracted account
        .arc58VerifyAuthAddr({})
        .execute();
    });
  });

  describe('spendingAccount1 spends from abstracted account', () => {
    test('Alice sets ASSET spending limit for spendingAccount1', async () => {
      await spendingLimitPluginClient.appClient.fundAppAccount({
        amount: algokit.microAlgos(SPENDING_LIMIT_MBR)
      });
      await spendingLimitPluginClient
        .compose()
        .setSpendingLimit({
          account: spendingAccount1.addr,
          assetId: asset,
          limit: 10_000_000,
        }, {
          sender: aliceEOA,
          apps: [abstractedAccountAppID],
          boxes: [
            new Uint8Array(
              Buffer.concat([
                Buffer.from('sl'),
                algosdk.decodeAddress(spendingAccount1.addr).publicKey,
                Buffer.from(algosdk.encodeUint64(asset)),
              ])
            )
          ]
        })
        .execute();
    });

    test('spendingAccount1 spends ASSET', async () => {
      await abstractedAccountClient
        .compose()
        // Step one: rekey to the plugin
        .arc58RekeyToPlugin(
          { plugin: spendingLimitPluginID },
          {
            sender: spendingAccount1,
            sendParams: { fee: algokit.microAlgos(4_000) },
            boxes: [new Uint8Array(
              Buffer.concat([
                Buffer.from('p'),
                Buffer.from(algosdk.encodeUint64(spendingLimitPluginID)),
                algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
              ]),
            )],
          }
        )
        // Step two: Call the plugin
        .addTransaction((await spendingLimitPluginClient
          .compose()
          .spend({
            controlledAccount: aliceAbstractedAccount,
            receiver: spendingAccount1.addr,
            assetId: asset,
            amount: 1_000_000,
          }, {
            sender: spendingAccount1,
            apps: [abstractedAccountAppID],
            assets: [asset],
            boxes: [
              new Uint8Array(
                Buffer.concat([
                  Buffer.from('sl'),
                  algosdk.decodeAddress(spendingAccount1.addr).publicKey,
                  Buffer.from(algosdk.encodeUint64(asset)),
                ])
              )
            ],
            sendParams: { fee: algokit.microAlgos(0) },
          }).atc()).buildGroup()[0]
        )
        // Step three: Call verify auth addr to rekey back to the abstracted account
        .arc58VerifyAuthAddr({})
        .execute();
    });

    test('Alice removes ASSET spending limit for spendingAccount1', async () => {
      await spendingLimitPluginClient
        .compose()
        .removeSpendingLimit({
          account: spendingAccount1.addr,
          assetId: asset,
        }, {
          sender: aliceEOA,
          apps: [abstractedAccountAppID],
          boxes: [
            new Uint8Array(
              Buffer.concat([
                Buffer.from('sl'),
                algosdk.decodeAddress(spendingAccount1.addr).publicKey,
                Buffer.from(algosdk.encodeUint64(asset)),
              ])
            )
          ],
          sendParams: { fee: algokit.microAlgos(2000), },
        })
        .execute();
    });

    test('spendingAccount1 cannot spend ASSET after limit withdrawn', async () => {
      await expect(abstractedAccountClient
        .compose()
        // Step one: rekey to the plugin
        .arc58RekeyToPlugin(
          { plugin: spendingLimitPluginID },
          {
            sender: spendingAccount1,
            sendParams: { fee: algokit.microAlgos(4_000) },
            boxes: [new Uint8Array(
              Buffer.concat([
                Buffer.from('p'),
                Buffer.from(algosdk.encodeUint64(spendingLimitPluginID)),
                algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
              ]),
            )],
          }
        )
        // Step two: Call the plugin
        .addTransaction((await spendingLimitPluginClient
          .compose()
          .spend({
            controlledAccount: aliceAbstractedAccount,
            receiver: spendingAccount1.addr,
            assetId: asset,
            amount: 1_000_000,
          }, {
            sender: spendingAccount1,
            apps: [abstractedAccountAppID],
            assets: [asset],
            boxes: [
              new Uint8Array(
                Buffer.concat([
                  Buffer.from('sl'),
                  algosdk.decodeAddress(spendingAccount1.addr).publicKey,
                  Buffer.from(algosdk.encodeUint64(asset)),
                ])
              )
            ],
            sendParams: { fee: algokit.microAlgos(0) },
          }).atc()).buildGroup()[0]
        )
        // Step three: Call verify auth addr to rekey back to the abstracted account
        .arc58VerifyAuthAddr({})
        .execute()
      ).rejects.toThrowError();
    });
  });
});