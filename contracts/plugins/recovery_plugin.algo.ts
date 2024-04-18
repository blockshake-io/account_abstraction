import { Contract } from '@algorandfoundation/tealscript';

const UINT64_MAX = 0 + 18446744073709551615;

export class RecoveryPlugin extends Contract {
    programVersion = 10;

    /** The account that this recovery plugin can recover */
    controlledAccount = GlobalStateKey<Address>({ key: 'ca' });
    /** The account can use this plugin to recover the controlledAccount */
    recoveryAccount = GlobalStateKey<Address>({ key: 'ra' });
    /** The round when recovery was started  */
    recoveryStartRound = GlobalStateKey<uint64>({ key: 'rs' });
    /**
     * The number of rounds that have to pass before the recovery account can finalize recovery.
     * Only after that number of rounds have passed and the controlled account hasn't rejected
     * the recovery attempt, the recovery account is allowed to take ownership of the recovery
     * account.
     */
    graceRounds = GlobalStateKey<uint64>({ key: 'gr' });

    @allow.create("NoOp")
    createApplication(controlledAccount: Address, recoveryAccount: Address, graceRounds: uint64): void {
        this.controlledAccount.value = controlledAccount;
        this.recoveryAccount.value = recoveryAccount;
        this.graceRounds.value = graceRounds;
        this.recoveryStartRound.value = UINT64_MAX;
    }

    initiateRecovery(): void {
        verifyTxn(this.txn, { sender: this.recoveryAccount.value });
        this.recoveryStartRound.value = globals.round;
    }

    abortRecovery(): void {
        verifyTxn(this.txn, { sender: this.controlledAccount.value });
        this.recoveryStartRound.value = UINT64_MAX;
    }

    recover(abstractedAccountApp: AppID, controlledAccount: Address): void {
        // ensure that only the recovery account can call this function
        // after at least the number of grace rounds have passed
        verifyTxn(this.txn, { sender: this.recoveryAccount.value });
        assert(this.controlledAccount.value == controlledAccount);
        assert(this.recoveryStartRound.value != UINT64_MAX);
        assert(this.recoveryStartRound.value + this.graceRounds.value <= globals.round);

        // change the admin of the abstracted account app to the recovery account
        sendMethodCall<[Address], void>({
            name: 'arc58_changeAdmin',
            applicationID: abstractedAccountApp,
            applicationArgs: [rawBytes(this.recoveryAccount.value)],
        });

        // rekey the controlled account back to itself
        sendPayment({
            sender: controlledAccount,
            receiver: controlledAccount,
            rekeyTo: controlledAccount,
            amount: 0,
        });
    }
}
