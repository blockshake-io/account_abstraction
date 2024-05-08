import { Contract } from '@algorandfoundation/tealscript';

type SpendingLimitKey = {
  account: Address,
  asset: uint64,
}

type SpendingLimit = {
  limit: uint64,
  timestamp: uint64,
  spentAmount: uint64,
}

export class SpendingLimitPlugin extends Contract {
  programVersion = 10;

  abstractedAccountAppID = GlobalStateKey<uint64>();
  timePeriod = GlobalStateKey<uint64>();
  spendingLimits = BoxMap<SpendingLimitKey, SpendingLimit>({ prefix: 'sl' });

  @allow.create("NoOp")
  createApplication(abstractedAccountApp: uint64, timePeriod: uint64): void {
    assert(timePeriod > 0);
    this.abstractedAccountAppID.value = abstractedAccountApp;
    this.timePeriod.value = timePeriod;
  }

  _getApp(): AppID {
    return AppID.fromUint64(this.abstractedAccountAppID.value);
  }

  _getAppAdmin(): Address {
    return this._getApp().globalState("a") as Address;
  }

  setSpendingLimit(account: Address, assetId: uint64, limit: uint64) {
    assert(this.txn.sender == this._getAppAdmin());
    this.spendingLimits({
      account: account,
      asset: assetId,
    }).value = {
      limit: limit,
      timestamp: 0,
      spentAmount: 0,
    };
  }

  removeSpendingLimit(account: Address, assetId: uint64) {
    assert(this.txn.sender == this._getAppAdmin());
    this.spendingLimits({
      account: account,
      asset: assetId,
    }).delete();
  }

  spend(
    controlledAccount: Address,
    receiver: Address,
    assetId: uint64,
    amount: uint64,
  ): void {
    let key: SpendingLimitKey = {
      account: this.txn.sender,
      asset: assetId,
    }

    // check that the transaction sender is allowed to spend the
    // given asset from the controlled account
    assert(this.spendingLimits(key).exists);
    let spendingLimit = this.spendingLimits(key).value;

    // check that the requested amount can be spent
    let spentAmount = amount;
    let timestamp = globals.latestTimestamp - (globals.latestTimestamp % this.timePeriod.value);
    if (spendingLimit.timestamp == timestamp) {
      spentAmount = spentAmount + spendingLimit.spentAmount;
    }
    assert(spentAmount <= spendingLimit.limit);
    spendingLimit.spentAmount = spentAmount;
    spendingLimit.timestamp = timestamp;

    // send the requested amount to the stated receiver
    if (assetId == 0) {
      sendPayment({
        sender: controlledAccount,
        receiver: receiver,
        amount: amount,
        rekeyTo: controlledAccount,
      });
    } else {
      sendAssetTransfer({
        sender: controlledAccount,
        xferAsset: AssetID.fromUint64(assetId),
        assetReceiver: receiver,
        assetAmount: amount,
        rekeyTo: controlledAccount,
      })
    }
  }
}
