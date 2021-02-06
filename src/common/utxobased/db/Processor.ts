import { BaseType, createCountBase, createHashBase, createRangeBase, openBase } from 'baselet'
import { CountBase } from 'baselet/src/CountBase'
import { HashBase } from 'baselet/src/HashBase'
import { RangeBase } from 'baselet/src/RangeBase'
import * as bs from 'biggystring'
import { Disklet } from 'disklet'

import { Baselet, BaseletConfig, IAddress, IProcessorTransaction, IUTXO } from './types'
import { toProcessorTransaction } from './Models/ProcessorTransaction'
import { AddressPath, EmitterEvent } from '../../plugin/types'
import {
  AddressByScriptPubkey,
  addressByScriptPubkeyConfig,
  addressPathByMRUConfig,
  addressPathToPrefix,
  RANGE_ID_KEY,
  RANGE_KEY,
  ScriptPubkeyByPath,
  scriptPubkeyByPathConfig,
  ScriptPubkeysByBalance,
  scriptPubkeysByBalanceConfig,
  TxById,
  txByIdConfig, TxsByDate,
  txsByDateConfig,
  TxsByScriptPubkey,
  txsByScriptPubkeyConfig,
  UtxoById,
  utxoByIdConfig,
  utxoIdsByScriptPubkeyConfig,
  utxoIdsBySizeConfig,
} from './Models/baselet'
import { EdgeGetTransactionsOptions } from 'edge-core-js/lib/types'
import { makeTaskPicker, Task, TaskPriority } from '../engine/makeTaskPicker'

interface ProcessorEmitter {
  emit(event: EmitterEvent.PROCESSOR_TRANSACTION_CHANGED, transaction: IProcessorTransaction): boolean
}

interface ProcessorConfig {
  disklet: Disklet
  emitter: ProcessorEmitter,
}

export interface Processor {
  fetchScriptPubkeyByPath(path: AddressPath): Promise<ScriptPubkeyByPath>

  fetchAddressByScriptPubkey(scriptPubkey: string): Promise<AddressByScriptPubkey>

  hasSPubKey(scriptPubkey: string): Promise<boolean>

  fetchAddressCountFromPathPartition(path: Omit<AddressPath, 'addressIndex'>): number

  fetchScriptPubkeysByBalance(): Promise<ScriptPubkeysByBalance[]>

  saveAddress(data: IAddress): Promise<void>

  updateAddressByScriptPubkey(scriptPubkey: string, data: Partial<IAddress>): Promise<void>

  fetchTransaction(txId: string): Promise<TxById>

  fetchTransactionsByScriptPubkey(scriptHash: string): Promise<TxsByScriptPubkey>

  fetchTransactions(opts: EdgeGetTransactionsOptions): Promise<IProcessorTransaction[]>

  saveTransaction(tx: IProcessorTransaction): Promise<void>

  updateTransaction(txId: string, data: Pick<IProcessorTransaction, 'blockHeight'>): Promise<void>

  dropTransaction(txId: string): Promise<void>

  fetchUtxo(id: string): Promise<UtxoById>

  fetchUtxosByScriptPubkey(scriptPubkey: string): Promise<IUTXO[]>

  fetchAllUtxos(): Promise<IUTXO[]>

  saveUtxo(utxo: IUTXO): Promise<void>

  removeUtxo(utxo: IUTXO): Promise<void>
}

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

export async function makeProcessor(config: ProcessorConfig): Promise<Processor> {
  // const queue = makeQueue()
  const taskPicker = await makeTaskPicker()
  const {
    disklet,
    emitter
  } = config

  const [
    scriptPubkeyByPath,
    addressByScriptPubkey,
    addressPathByMRU,
    scriptPubkeysByBalance,
    txById,
    txsByScriptPubkey,
    txsByDate,
    utxoById,
    utxoIdsByScriptPubkey,
    utxoIdsBySize
  ] = await Promise.all([
    createOrOpen(disklet, scriptPubkeyByPathConfig),
    createOrOpen(disklet, addressByScriptPubkeyConfig),
    createOrOpen(disklet, addressPathByMRUConfig),
    createOrOpen(disklet, scriptPubkeysByBalanceConfig),
    createOrOpen(disklet, txByIdConfig),
    createOrOpen(disklet, txsByScriptPubkeyConfig),
    createOrOpen(disklet, txsByDateConfig),
    createOrOpen(disklet, utxoByIdConfig),
    createOrOpen(disklet, utxoIdsByScriptPubkeyConfig),
    createOrOpen(disklet, utxoIdsBySizeConfig)
  ])

  const addTask = async (task: Task, priority = TaskPriority.HIGH) => {
    await taskPicker.waitForQueueSize()
    return taskPicker.addTask({
      wait: true,
      task,
      priority
    })
  }

  async function innerFetchAddressesByScriptPubkeys(scriptPubkeys: string[]): Promise<AddressByScriptPubkey[]> {
    if (scriptPubkeys.length === 0) return []
    const addresses: AddressByScriptPubkey[] = await addressByScriptPubkey.query('', scriptPubkeys)

    // Update the last query values
    const now = Date.now()
    addresses.forEach((address) => {
      if (address) {
        addTask(() =>
          innerUpdateAddressByScriptPubkey(address.scriptPubkey, {
            lastQuery: now
          }),
          TaskPriority.LOW
        )
      }
    })

    return addresses
  }

  async function saveTransactionByScriptPubkey(
    scriptPubkey: string,
    tx: IProcessorTransaction,
    isInput: boolean,
    index: number,
    save = true
  ) {
    const txs = await fns.fetchTransactionsByScriptPubkey(scriptPubkey)
    if (!txs[tx.txid]) {
      txs[tx.txid] = {
        ins: {},
        outs: {}
      }
    }
    if (save) {
      if (isInput) {
        txs[tx.txid].ins[index] = true
      } else {
        txs[tx.txid].outs[index] = true
      }
    } else {
      if (isInput) {
        delete txs[tx.txid].ins[index]
      } else {
        delete txs[tx.txid].outs[index]
      }
    }

    await txsByScriptPubkey.insert('', scriptPubkey, txs)

    return txs
  }

  async function calculateTransactionAmount(tx: IProcessorTransaction): Promise<string> {
    let ourAmount = '0'
    for (const i of tx.ourIns) {
      const { amount } = tx.inputs[parseInt(i)]
      ourAmount = bs.sub(ourAmount, amount)
    }
    for (const i of tx.ourOuts) {
      const { amount } = tx.outputs[parseInt(i)]
      ourAmount = bs.add(ourAmount, amount)
    }

    return ourAmount
  }

  async function processScriptPubkeyTransactions(scriptPubkey: string): Promise<void> {
    // Find transactions associated with this scriptPubkey, process the balances and save it
    const byScriptPubkey = await fns.fetchTransactionsByScriptPubkey(scriptPubkey)
    for (const txId in byScriptPubkey) {
      const tx = byScriptPubkey[txId]
      const txData = await fns.fetchTransaction(txId)
      if (txData) {
        txData.ourIns = Object.keys(tx.ins)
        txData.ourOuts = Object.keys(tx.outs)

        addTask(() =>
          innerUpdateAddressByScriptPubkey(scriptPubkey, {
            lastTouched: txData.date,
            used: true
          }),
          TaskPriority.LOW
        )

        txData.ourAmount = await calculateTransactionAmount(txData)
        await innerUpdateTransaction(txId, txData, true)
      }
    }
  }

  async function innerSaveScriptPubkeyByPath(scriptPubkey: string, path: AddressPath): Promise<void> {
    await scriptPubkeyByPath.insert(
      addressPathToPrefix(path),
      path.addressIndex,
      scriptPubkey
    )
  }

  async function innerUpdateAddressByScriptPubkey(scriptPubkey: string, data: Partial<IAddress>): Promise<IAddress> {
    const [ addressData ] = await addressByScriptPubkey.query('', [ scriptPubkey ])
    if (!addressData) {
      throw new Error('Cannot update address that does not exist')
    }

    const promises: Promise<any>[] = []

    if (
      data.networkQueryVal != null &&
      data.networkQueryVal > addressData.networkQueryVal
    ) {
      addressData.networkQueryVal = data.networkQueryVal
    }

    if (data.lastQuery != null && data.lastQuery > addressData.lastQuery) {
      addressData.lastQuery = data.lastQuery
    }

    if (data.lastTouched != null && data.lastTouched > addressData.lastTouched) {
      addressData.lastTouched = data.lastTouched
    }

    if (data.used && !addressData.used) {
      addressData.used = data.used
    }

    if (data.balance != null && data.balance !== addressData.balance) {
      const oldRange = parseInt(addressData.balance)
      addressData.balance = data.balance
      promises.push(
        scriptPubkeysByBalance.update('', oldRange, {
          [RANGE_ID_KEY]: addressData.scriptPubkey,
          [RANGE_KEY]: parseInt(data.balance)
        })
      )
    }

    if (data.path != null && addressData.path == null) {
      promises.push(
        innerSaveScriptPubkeyByPath(scriptPubkey, data.path)
      )
    }

    await Promise.all([
      ...promises,
      addressByScriptPubkey.insert('', addressData.scriptPubkey, addressData)
    ])

    return addressData
  }

  async function innerSaveTransaction(tx: IProcessorTransaction): Promise<void> {
    const existingTx = await fns.fetchTransaction(tx.txid)
    if (!existingTx) {
      try {
        await txsByDate.insert('', {
          [RANGE_ID_KEY]: tx.txid,
          [RANGE_KEY]: tx.date
        })
      } catch (err) {
        console.log('tx already saved by date')
      }
    }

    for (const inOout of [ true, false ]) {
      const arr = inOout ? tx.inputs : tx.outputs
      for (let i = 0; i < arr.length; i++) {
        const { scriptPubkey, amount } = arr[i]

        const txs = await saveTransactionByScriptPubkey(scriptPubkey, tx, inOout, i)
        const own = await fns.hasSPubKey(scriptPubkey)
        if (own) {
          if (inOout) {
            tx.ourIns = Object.keys(txs[tx.txid].ins)
          } else {
            tx.ourOuts = Object.keys(txs[tx.txid].outs)
          }

          await innerUpdateAddressByScriptPubkey(scriptPubkey, {
            networkQueryVal: tx.blockHeight + 1,
            lastTouched: tx.date,
            used: true
          })
        }
      }
    }

    tx.ourAmount = await calculateTransactionAmount(tx)
    await txById.insert('', tx.txid, tx)
  }

  async function innerUpdateTransaction(
    txId: string,
    data: IProcessorTransaction,
    merge = false
  ) {
    let txData = await fns.fetchTransaction(txId)
    if (!txData && !merge) {
      throw new Error('Cannot update transaction that does not exists')
    } else {
      txData = data
    }

    txData.blockHeight = data.blockHeight

    if (merge) {
      const ins = new Set(txData.ourIns.concat(data.ourIns))
      const outs = new Set(txData.ourOuts.concat(data.ourOuts))
      txData.ourIns = Array.from(ins)
      txData.ourOuts = Array.from(outs)
    } else {
      txData.ourIns = data.ourIns
      txData.ourOuts = data.ourOuts
    }

    txData.ourAmount = data.ourAmount

    emitter.emit(EmitterEvent.PROCESSOR_TRANSACTION_CHANGED, txData)

    await txById.insert('', txId, txData)
  }

  async function innerDropTransaction(txId: string) {
    const tx = await fns.fetchTransaction(txId)
    if (!tx) return

    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i]

      await saveTransactionByScriptPubkey(input.scriptPubkey, tx, true, i, false)
    }

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i]

      await saveTransactionByScriptPubkey(output.scriptPubkey, tx, false, i, false)
    }

    tx.blockHeight = -1
    await txById.insert('', tx.txid, tx)

    // TODO: recalculate balances
  }

  async function innerSaveUtxo(utxo: IUTXO) {
    await utxoById.insert('', utxo.id, utxo)
    await utxoIdsBySize.insert('', {
      [RANGE_ID_KEY]: utxo.id,
      [RANGE_KEY]: parseInt(utxo.value)
    }).catch(() => {})

    const [ utxoIds ] = await utxoIdsByScriptPubkey.query('', [ utxo.scriptPubkey ])
    const set = new Set(utxoIds)
    set.add(utxo.id)
    await utxoIdsByScriptPubkey.insert('', utxo.scriptPubkey, Array.from(set))
  }

  async function innerRemoveUtxo(utxo: IUTXO) {
    await utxoById.delete('', [ utxo.id ])
    await utxoIdsBySize.delete('', parseInt(utxo.value), utxo.id)
    await utxoIdsByScriptPubkey.delete('', [ utxo.scriptPubkey ])
  }

  const fns: Processor = {
    async fetchScriptPubkeyByPath(path: AddressPath): Promise<ScriptPubkeyByPath> {
      const [ scriptPubkey ] = await scriptPubkeyByPath.query(
        addressPathToPrefix(path),
        path.addressIndex
      )
      return scriptPubkey
    },

    async fetchAddressByScriptPubkey(scriptPubkey: string): Promise<AddressByScriptPubkey> {
      const [ address ] = await innerFetchAddressesByScriptPubkeys([ scriptPubkey ])
      return address
    },

    async hasSPubKey(scriptPubkey: string): Promise<boolean> {
      return fns.fetchAddressByScriptPubkey(scriptPubkey).then(
        (address) => !!address
      )
    },

    fetchAddressCountFromPathPartition(path: Omit<AddressPath, 'addressIndex'>): number {
      return scriptPubkeyByPath.length(addressPathToPrefix(path))
    },

    // Returned in lowest first due to RangeBase
    async fetchScriptPubkeysByBalance(): Promise<ScriptPubkeysByBalance[]> {
      const max = scriptPubkeysByBalance.max('') ?? 0
      return scriptPubkeysByBalance.query('', 0, max)
    },

    async saveAddress(data: IAddress): Promise<void> {
      const [ addressData ] = await addressByScriptPubkey.query('', [ data.scriptPubkey ])
      if (addressData != null) {
        throw new Error('Address already exists. To update its data call `updateAddressByScriptPubkey`')
      }

      await addTask(async () => {
        const promises: Promise<any>[] = []

        // If there is path info on the address to save but not stored in
        // the previously existing data, save to the by path database.
        if (data.path && !addressData?.path) {
          promises.push(
            innerSaveScriptPubkeyByPath(data.scriptPubkey, data.path)
          )
        }

        try {
          promises.push(
            addressByScriptPubkey.insert(
              '',
              data.scriptPubkey,
              data
            )
          )

          promises.push(
            scriptPubkeysByBalance.insert('', {
              [RANGE_ID_KEY]: data.scriptPubkey,
              [RANGE_KEY]: parseInt(data.balance)
            })
          )

          // TODO:
          // promises.push(addressByMRU.insert('', index, data))

          await Promise.all(promises)

          await processScriptPubkeyTransactions(data.scriptPubkey)
        } catch (err) {
          // Undo any changes we made on a fail
          await addressByScriptPubkey.delete('', [ data.scriptPubkey ])

          await scriptPubkeysByBalance.delete('', parseInt(data.balance), data.scriptPubkey)

          // TODO:
          // addressByMRU.delete()
        }
      })
    },

    async updateAddressByScriptPubkey(
      scriptPubkey: string,
      data: Partial<IAddress>
    ): Promise<void> {
      await addTask(() => innerUpdateAddressByScriptPubkey(scriptPubkey, data))
    },

    async fetchTransaction(txId: string): Promise<TxById> {
      const [ data ] = await txById.query('', [ txId ])
      return data ? toProcessorTransaction(data) : undefined
    },

    async fetchTransactionsByScriptPubkey(
      scriptHash: string
    ): Promise<TxsByScriptPubkey> {
      const [ txs ] = await txsByScriptPubkey.query('', [ scriptHash ])
      return txs ?? {}
    },

    async fetchTransactions(opts: EdgeGetTransactionsOptions): Promise<IProcessorTransaction[]> {
      const {
        startEntries = 10,
        startIndex = 0,
        startDate,
        endDate
      } = opts

      let txData: TxsByDate
      if (startDate) {
        txData = await txsByDate.query('', startDate.getTime(), endDate?.getTime())
      } else {
        txData = await txsByDate.queryByCount('', startEntries, startIndex)
      }

      const txPromises = txData.map(({ [RANGE_ID_KEY]: txId }) =>
        txById.query('', [ txId ]).then(([ tx ]) => tx)
      )
      return Promise.all(txPromises)
    },

    async saveTransaction(tx: IProcessorTransaction): Promise<void> {
      await addTask(() => innerSaveTransaction(tx))
    },

    async updateTransaction(
      txId: string,
      data: IProcessorTransaction
    ): Promise<void> {
      await addTask(() => innerUpdateTransaction(txId, data))
    },

    // TODO: delete everything from db?
    async dropTransaction(txId: string): Promise<void> {
      await addTask(() => innerDropTransaction(txId))
    },

    async fetchUtxo(id: string): Promise<IUTXO> {
      const [ utxo ] = await utxoById.query('', [ id ])
      return utxo
    },

    async fetchUtxosByScriptPubkey(scriptPubkey: string): Promise<IUTXO[]> {
      const [ ids = [] ] = await utxoIdsByScriptPubkey.query('', [ scriptPubkey ])
      return ids.length === 0 ? [] : utxoById.query('', ids)
    },

    async fetchAllUtxos(): Promise<IUTXO[]> {
      const result = await utxoIdsBySize.query('', 0, utxoIdsBySize.max(''))
      const ids = result.map(({ [RANGE_ID_KEY]: id }) => id)
      return ids.length === 0 ? [] : utxoById.query('', ids)
    },

    async saveUtxo(utxo: IUTXO): Promise<void> {
      await addTask(() => innerSaveUtxo(utxo))
    },

    async removeUtxo(utxo: IUTXO): Promise<void> {
      await addTask(() => innerRemoveUtxo(utxo))
    }
  }

  return fns
}
