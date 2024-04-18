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
    /** The client for the subscription plugin */
    let subPluginClient: SubscriptionPluginClient;
    /** The ID of the subscription plugin */
    let subPluginID: number;
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
        await abstractedAccountClient.appClient.fundAppAccount({ amount: algokit.microAlgos(300_000) });

        // Deploy the subscription plugin
        subPluginClient = new SubscriptionPluginClient(
            {
                sender: aliceEOA,
                resolveBy: 'id',
                id: 0,
            },
            algod
        );
        await subPluginClient.create.createApplication({});
        subPluginID = Number((await subPluginClient.appClient.getAppReference()).appId);
    });

    describe('Subscription Plugin', () => {
        /** Another account that the subscription payments will go to */
        const joe = '46XYR7OTRZXISI2TRSBDWPUVQT4ECBWNI7TFWPPS6EKAPJ7W5OBXSNG66M';
        /** The box key for the subscription plugin */
        let pluginBox: Uint8Array;
        /** The boxes to pass to app calls */
        let boxes: Uint8Array[];

        beforeAll(() => {
            /** The box key for a plugin is `p + plugin ID + allowed caller`  */
            pluginBox = new Uint8Array(
                Buffer.concat([
                    Buffer.from('p'),
                    Buffer.from(algosdk.encodeUint64(subPluginID)),
                    algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
                ])
            );
            boxes = [pluginBox];
        });

        test('Alice adds the app to the abstracted account', async () => {
            await abstractedAccountClient.arc58AddPlugin(
                {
                    // Add the subscription plugin
                    app: subPluginID,
                    // Set address to ZERO_ADDRESS so anyone can call it
                    allowedCaller: ZERO_ADDRESS,
                    // Set end to maxUint64 so it never expires
                    end: maxUint64,
                },
                { boxes }
            );
        });

        test('Someone calls the program to trigger payment', async () => {
            const { algod, testAccount } = fixture.context;

            boxes = [
                new Uint8Array(
                    Buffer.concat([
                        Buffer.from('p'),
                        Buffer.from(algosdk.encodeUint64(subPluginID)),
                        algosdk.decodeAddress(ZERO_ADDRESS).publicKey,
                    ])
                ),
            ];

            const alicePreBalance = await algod.accountInformation(aliceAbstractedAccount).do();
            const joePreBalance = await algod.accountInformation(joe).do();

            // Get the call to the subscription plugin
            const makePaymentTxn = (
                await subPluginClient
                    .compose()
                    .makePayment(
                        // Send a payment from the abstracted account to Joe
                        { sender: aliceAbstractedAccount, _acctRef: joe },
                        // Double the fee to cover the inner txn fee
                        {
                            sender: testAccount,
                            sendParams: { fee: algokit.microAlgos(2_000) },
                            accounts: [aliceAbstractedAccount, joe]
                        }
                    )
                    .atc()
            ).buildGroup()[0].txn;

            // Compose the group needed to actually use the plugin
            await abstractedAccountClient
                .compose()
                // Step one: rekey to the plugin
                .arc58RekeyToPlugin(
                    { plugin: subPluginID },
                    {
                        sender: testAccount,
                        boxes,
                        sendParams: { fee: algokit.microAlgos(2_000) },
                    }
                )
                // Step two: Call the plugin
                .addTransaction({ transaction: makePaymentTxn, signer: testAccount })
                // Step three: Call verify auth addr to rekey back to the abstracted account
                .arc58VerifyAuthAddr({})
                .execute();

            // Verify the payment was made
            const alicePostBalance = await algod.accountInformation(aliceAbstractedAccount).do();
            const joePostBalance = await algod.accountInformation(joe).do();
            expect(alicePostBalance.amount).toBe(alicePreBalance.amount - 100_000);
            expect(joePostBalance.amount).toBe(joePreBalance.amount + 100_000);
        });
    });
});
