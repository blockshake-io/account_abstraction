import { describe, test, beforeAll, beforeEach, expect } from '@jest/globals';
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing';
import * as algokit from '@algorandfoundation/algokit-utils';
import algosdk from 'algosdk';
import { AbstractedAccountClient } from '../contracts/clients/AbstractedAccountClient';
import { SubscriptionPluginClient } from '../contracts/clients/SubscriptionPluginClient';
import { OptInPluginClient } from '../contracts/clients/OptInPluginClient';

const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const fixture = algorandFixture();

describe('Abstracted Subscription Program', () => {
    /** Alice's externally owned account (ie. a keypair account she has in Defly) */
    let aliceEOA: algosdk.Account;
    /** The address of Alice's new abstracted account. Sends app calls from aliceEOA unless otherwise specified */
    let aliceAbstractedAccount: string;
    /** The client for Alice's abstracted account */
    let abstractedAccountClient: AbstractedAccountClient;
    /** The client for the opt-in plugin */
    let optInPluginClient: OptInPluginClient;
    /** The ID of the opt-in plugin */
    let optInPluginID: number;
    /** The suggested params for transactions */
    let suggestedParams: algosdk.SuggestedParams;

    /** The maximum uint64 value. Used to indicate a never-expiring plugin */
    const maxUint64 = BigInt('18446744073709551615');

    beforeEach(fixture.beforeEach);

    beforeAll(async () => {
        await fixture.beforeEach();
        const { algod, testAccount } = fixture.context;
        suggestedParams = await algod.getTransactionParams().do();
        aliceEOA = testAccount;

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

        // Fund the abstracted account
        await abstractedAccountClient.appClient.fundAppAccount({ amount: algokit.microAlgos(100_000) });

        // Deploy the opt-in plugin
        optInPluginClient = new OptInPluginClient(
            {
                sender: aliceEOA,
                resolveBy: 'id',
                id: 0,
            },
            algod
        );
        await optInPluginClient.create.createApplication({});
        optInPluginID = Number((await optInPluginClient.appClient.getAppReference()).appId);
    });

    describe('OptIn Plugin', () => {
        let bob: algosdk.Account;
        let asset: number;

        const nameBox = new Uint8Array(Buffer.concat([Buffer.from('n'), Buffer.from('optIn')]));

        let pluginBox: Uint8Array;

        const boxes: Uint8Array[] = [nameBox];

        beforeAll(async () => {
            bob = fixture.context.testAccount;
            const { algod } = fixture.context;

            // Create an asset
            const assetCreateTxn = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
                from: bob.addr,
                total: 1,
                decimals: 0,
                defaultFrozen: false,
                suggestedParams,
            });
            const txn = await algokit.sendTransaction({ transaction: assetCreateTxn, from: bob }, algod);
            asset = Number(txn.confirmation!.assetIndex!);

            pluginBox = new Uint8Array(
                Buffer.concat([
                    Buffer.from('p'),
                    Buffer.from(algosdk.encodeUint64(optInPluginID)),
                    algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
                ])
            );

            boxes.push(pluginBox);
        });

        test('Alice adds the app to the abstracted account', async () => {
            await abstractedAccountClient.appClient.fundAppAccount({ amount: algokit.microAlgos(43000) });

            // Add opt-in plugin
            await abstractedAccountClient.arc58AddPlugin(
                { app: optInPluginID, allowedCaller: ZERO_ADDRESS, end: maxUint64 },
                { boxes }
            );
        });

        test("Bob opts Alice's abstracted account into the asset", async () => {
            // Form a payment from bob to alice's abstracted account to cover the MBR
            const mbrPayment = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
                from: bob.addr,
                to: aliceAbstractedAccount,
                amount: 100_000,
                suggestedParams: { ...suggestedParams, fee: 1000, flatFee: true },
            });

            console.log("aliceAbstractedAccount: " + aliceAbstractedAccount);
            // Form the group txn needed to call the opt-in plugin
            const optInGroup = (
                await optInPluginClient
                    .compose()
                    .optInToAsset(
                        { sender: aliceAbstractedAccount, asset, mbrPayment },
                        {
                            sender: bob,
                            sendParams: { fee: algokit.microAlgos(2000) },
                            assets: [asset],
                            accounts: [aliceAbstractedAccount],
                        }
                    )
                    .atc()
            ).buildGroup();
            optInGroup.forEach((txn) => {
                // eslint-disable-next-line no-param-reassign
                txn.txn.group = undefined;
            });

            // Compose the group needed to actually use the plugin
            await abstractedAccountClient
                .compose()
                // Rekey to the opt-in plugin
                .arc58RekeyToPlugin(
                    { plugin: optInPluginID },
                    {
                        boxes,
                        sendParams: { fee: algokit.microAlgos(2000) },
                    }
                )
                // Add the mbr payment
                .addTransaction({ transaction: optInGroup[0].txn, signer: bob }) // mbrPayment
                // Add the opt-in plugin call
                .addTransaction({ transaction: optInGroup[1].txn, signer: bob }) // optInToAsset
                // Call verify auth addr to verify the abstracted account is rekeyed back to itself
                .arc58VerifyAuthAddr({})
                .execute();
        });
    });
});
