import { Disklet } from 'disklet'
import { BaseType, createCountBase, createHashBase, createRangeBase, openBase } from 'baselet'
import { HashBase } from 'baselet/src/HashBase'
import { CountBase } from 'baselet/src/CountBase'
import { RangeBase } from 'baselet/src/RangeBase'
import { Mutex } from 'async-mutex'

import { Baselet, BaseletConfig } from './types'
import {
  addressByScriptPubkeyConfig,
  addressPathByMRUConfig,
  RANGE_ID_KEY,
  RANGE_KEY,
  scriptPubkeyByPathConfig,
  scriptPubkeysByBalanceConfig,
  txByIdConfig,
  txIdsByBlockHeightConfig,
  txsByDateConfig,
  txsByScriptPubkeyConfig, utxoByIdConfig, utxoIdsByScriptPubkeyConfig,
  utxoIdsBySizeConfig,
} from './Models/baselet'

async function createOrOpen(disklet: Disklet, config: BaseletConfig<BaseType.HashBase>): Promise<HashBase>
async function createOrOpen(disklet: Disklet, config: BaseletConfig<BaseType.CountBase>): Promise<CountBase>
async function createOrOpen(disklet: Disklet, config: BaseletConfig<BaseType.RangeBase>): Promise<RangeBase>
async function createOrOpen<T extends BaseType>(
  disklet: Disklet,
  config: BaseletConfig<T>
): Promise<Baselet> {
  try {
    switch (config.type) {
      case BaseType.HashBase:
        return await createHashBase(disklet, config.dbName, config.bucketSize)
      case BaseType.CountBase:
        return await createCountBase(disklet, config.dbName, config.bucketSize)
      case BaseType.RangeBase:
        return await createRangeBase(disklet, config.dbName, config.bucketSize, RANGE_KEY, RANGE_ID_KEY)
    }
  } catch (err) {
    if (!err.message.includes('already exists')) {
      throw err
    }
  }
  return openBase(disklet, config.dbName)
}

interface MakeBaseletsConfig {
  disklet: Disklet
}

export interface Baselets {
  address: <E extends Executor<'address'>>(fn: E) => Promise<ReturnType<E>>
  tx: <E extends Executor<'tx'>>(fn: E) => Promise<ReturnType<E>>
  utxo: <E extends Executor<'utxo'>>(fn: E) => Promise<ReturnType<E>>
  all: AddressTables & TransactionTables & UTXOTables
}

type Executor<DatabaseName extends keyof Databases> = (tables: Databases[DatabaseName]) => Promise<any>

export interface Databases {
  address: AddressTables
  tx: TransactionTables
  utxo: UTXOTables
}

export interface AddressTables {
  addressByScriptPubkey: HashBase
  addressPathByMRU: CountBase
  scriptPubkeyByPath: CountBase
  scriptPubkeysByBalance: RangeBase
}

export interface TransactionTables {
  txById: HashBase
  txsByScriptPubkey: HashBase
  txIdsByBlockHeight: RangeBase
  txsByDate: RangeBase
}

export interface UTXOTables {
  utxoById: HashBase
  utxoIdsByScriptPubkey: HashBase
  utxoIdsBySize: RangeBase
}

export const makeBaselets = async (config: MakeBaseletsConfig): Promise<Baselets> => {
  const addressMutex = new Mutex()
  const txMutex = new Mutex()
  const utxoMutex = new Mutex()

  const countBases = await Promise.all([
    createOrOpen(config.disklet, scriptPubkeyByPathConfig),
    createOrOpen(config.disklet, addressPathByMRUConfig),
  ])
  const rangeBases = await Promise.all([
    createOrOpen(config.disklet, scriptPubkeysByBalanceConfig),
    createOrOpen(config.disklet, txIdsByBlockHeightConfig),
    createOrOpen(config.disklet, txsByDateConfig),
    createOrOpen(config.disklet, utxoIdsBySizeConfig)
  ])
  const hashBases = await Promise.all([
    createOrOpen(config.disklet, addressByScriptPubkeyConfig),
    createOrOpen(config.disklet, txByIdConfig),
    createOrOpen(config.disklet, txsByScriptPubkeyConfig),
    createOrOpen(config.disklet, utxoByIdConfig),
    createOrOpen(config.disklet, utxoIdsByScriptPubkeyConfig)
  ])

  const [
    scriptPubkeyByPath,
    addressPathByMRU
  ] = countBases
  const [
    scriptPubkeysByBalance,
    txIdsByBlockHeight,
    txsByDate,
    utxoIdsBySize
  ] = rangeBases
  const [
    addressByScriptPubkey,
    txById,
    txsByScriptPubkey,
    utxoById,
    utxoIdsByScriptPubkey
  ] = hashBases

  const addressBases: AddressTables = {
    addressByScriptPubkey,
    addressPathByMRU,
    scriptPubkeyByPath,
    scriptPubkeysByBalance,
  }

  const txBases: TransactionTables = {
    txById,
    txsByScriptPubkey,
    txIdsByBlockHeight,
    txsByDate,
  }

  const utxoBases: UTXOTables = {
    utxoById,
    utxoIdsByScriptPubkey,
    utxoIdsBySize,
  }

  return {
    address(fn: Executor<'address'>): Promise<any> {
      return addressMutex.runExclusive(() => fn(addressBases))
    },

    tx(fn: Executor<'tx'>): Promise<any> {
      return txMutex.runExclusive(() => fn(txBases))
    },

    utxo(fn: Executor<'utxo'>): Promise<any> {
      return utxoMutex.runExclusive(() => fn(utxoBases))
    },

    all: {
      ...addressBases,
      ...txBases,
      ...utxoBases,
    }
  }
}
