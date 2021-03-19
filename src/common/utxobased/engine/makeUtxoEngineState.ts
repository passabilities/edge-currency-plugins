import * as bs from 'biggystring'
import { EdgeFreshAddress, EdgeWalletInfo } from 'edge-core-js'

import {
  AddressPath,
  CurrencyFormat,
  Emitter,
  EmitterEvent,
  EngineConfig,
  EngineCurrencyInfo,
  NetworkEnum,
} from '../../plugin/types'
import { BlockBook, IAccountUTXO, ITransaction } from '../network/BlockBook'
import { IAddress, IProcessorTransaction, IUTXO } from '../db/types'
import { BIP43PurposeTypeEnum, ScriptTypeEnum } from '../keymanager/keymanager'
import { Processor } from '../db/makeProcessor'
import { UTXOPluginWalletTools } from './makeUtxoWalletTools'
import {
  currencyFormatToPurposeType,
  getCurrencyFormatFromPurposeType,
  getFormatSupportedBranches,
  getPurposeTypeFromKeys,
  getWalletSupportedFormats,
  validScriptPubkeyFromAddress,
} from './utils'
import { makeMutexor, Mutexor } from './mutexor'
import { BLOCKBOOK_TXS_PER_PAGE, CACHE_THROTTLE } from './constants'

export interface UtxoEngineState {
  start(): Promise<void>

  stop(): Promise<void>

  getFreshAddress(branch?: number): Promise<EdgeFreshAddress>

  addGapLimitAddresses(addresses: string[]): Promise<void>
}

export interface UtxoEngineStateConfig extends EngineConfig {
  walletTools: UTXOPluginWalletTools
  processor: Processor
  blockBook: BlockBook
}

export function makeUtxoEngineState(config: UtxoEngineStateConfig): UtxoEngineState {
  const {
    network,
    currencyInfo,
    walletInfo,
    walletTools,
    options: {
      emitter
    },
    processor,
    blockBook,
  } = config

  const addressesToWatch = new Set<string>()

  let processedCount = 0
  let processedPercent = 0
  const onAddressChecked = async () => {
    processedCount = processedCount + 1
    const totalCount = await getTotalAddressCount({ walletInfo, currencyInfo, processor })
    const percent = processedCount / totalCount
    console.log(percent + '%', processedCount)
    if (percent - processedPercent > CACHE_THROTTLE || percent === 1) {
      processedPercent = percent
      emitter.emit(EmitterEvent.ADDRESSES_CHECKED, percent)
    }
  }

  const mutexor = makeMutexor()

  const commonArgs: CommonArgs = {
    network,
    currencyInfo,
    walletInfo,
    walletTools,
    processor,
    blockBook,
    emitter,
    addressesToWatch,
    onAddressChecked,
    mutexor,
  }

  let running = false
  const run = async () => {
    if (running) return
    running = true

    const formatsToProcess = getWalletSupportedFormats(walletInfo)
    for (const format of formatsToProcess) {
      const branches = getFormatSupportedBranches(format)
      for (const branch of branches) {
        const args: SetLookAheadArgs = {
          ...commonArgs,
          format,
          branch,
        }
        await setLookAhead(args)
      }
    }
  }

  return {
    async start(): Promise<void> {
      processedCount = 0
      processedPercent = 0

      blockBook.watchBlocks(() => onNewBlock(commonArgs))

      await run()
    },

    async stop(): Promise<void> {
      // TODO: stop watching blocks
      // TODO: stop watching addresses
    },

    async getFreshAddress(branch = 0): Promise<EdgeFreshAddress> {
      const walletPurpose = getPurposeTypeFromKeys(walletInfo)
      if (walletPurpose === BIP43PurposeTypeEnum.Segwit) {
        const { address: publicAddress } = await internalGetFreshAddress({
          ...commonArgs,
          format: getCurrencyFormatFromPurposeType(BIP43PurposeTypeEnum.WrappedSegwit),
          branch: branch,
        })

        const { address: segwitAddress } = await internalGetFreshAddress({
          ...commonArgs,
          format: getCurrencyFormatFromPurposeType(BIP43PurposeTypeEnum.Segwit),
          branch: branch,
        })

        return {
          publicAddress,
          segwitAddress
        }
      } else {
        // Airbitz wallets only use branch 0
        if (walletPurpose !== BIP43PurposeTypeEnum.Airbitz) {
          branch = 0
        }

        const { address: publicAddress, legacyAddress } = await internalGetFreshAddress({
          ...commonArgs,
          format: getCurrencyFormatFromPurposeType(walletPurpose),
          branch: branch,
        })

        return {
          publicAddress,
          legacyAddress: legacyAddress !== publicAddress ? legacyAddress : undefined
        }
      }
    },

    async addGapLimitAddresses(addresses: string[]): Promise<void> {
      for (const addr of addresses) {
        await saveAddress({
          ...commonArgs,
          scriptPubkey: walletTools.addressToScriptPubkey(addr),
          used: true,
        })
      }
    }
  }
}

interface CommonArgs {
  network: NetworkEnum
  currencyInfo: EngineCurrencyInfo
  walletInfo: EdgeWalletInfo
  walletTools: UTXOPluginWalletTools
  processor: Processor
  blockBook: BlockBook
  emitter: Emitter
  addressesToWatch: Set<string>
  onAddressChecked: () => void
  mutexor: Mutexor
}

interface OnNewBlockArgs extends CommonArgs {
}

const onNewBlock = async (args: OnNewBlockArgs): Promise<void> => {
  const {
    processor,
    blockBook
  } = args

  const txIds = await processor.fetchTxIdsByBlockHeight(0)
  if (txIds === []) {
    return
  }
  for (const txId of txIds) {
    const rawTx = await blockBook.fetchTransaction(txId)
    const tx = processRawTx({ ...args, tx: rawTx })
    // check if tx is still not confirmed, if so, don't change anything
    if (tx.blockHeight < 1) {
      return
    }
    await processor.removeTxIdByBlockHeight(0, txId)
    await processor.insertTxIdByBlockHeight(tx.blockHeight, txId)
    await processor.updateTransaction(txId, tx)
  }
}

interface FormatArgs extends CommonArgs {
  format: CurrencyFormat
  branch: number
}

interface SetLookAheadArgs extends FormatArgs {
}

const setLookAhead = async (args: SetLookAheadArgs) => {
  const {
    format,
    branch,
    currencyInfo,
    walletTools,
    processor,
    mutexor,
  } = args

  await mutexor(`setLookAhead-${format}-${branch}`).runExclusive(async () => {
    const partialPath: Omit<AddressPath, 'addressIndex'> = {
      format,
      changeIndex: branch
    }

    const getLastUsed = () => findLastUsedIndex({ ...args, ...partialPath })
    const getAddressCount = () => processor.getNumAddressesFromPathPartition(partialPath)

    while (await getLastUsed() + currencyInfo.gapLimit > getAddressCount()) {
      const path: AddressPath = {
        ...partialPath,
        addressIndex: getAddressCount()
      }
      const { address } = walletTools.getAddress(path)
      const scriptPubkey = walletTools.addressToScriptPubkey(address)
      await saveAddress({
        ...args,
        scriptPubkey,
        path
      })

      // TODO: don't process addresses during setLookAhead. Addresses should be added to a queue here
      await processAddress({ ...args, address })
    }
  })
}

interface SaveAddressArgs extends CommonArgs {
  scriptPubkey: string
  path?: AddressPath
  used?: boolean
}

const saveAddress = async (args: SaveAddressArgs, count = 0): Promise<void> => {
  const {
    scriptPubkey,
    path,
    used = false,
    processor,
    mutexor
  } = args

  await mutexor('saveAddress').runExclusive(async () => {
    try {
      await processor.saveAddress({
        scriptPubkey,
        path,
        used,
        networkQueryVal: 0,
        lastQuery: 0,
        lastTouched: 0,
        balance: '0'
      })
    } catch (err) {
      if (err.message === 'Address already exists.') {
        await processor.updateAddressByScriptPubkey(scriptPubkey, {
          path,
          used,
        })
      } else {
        throw err
      }
    }
  })
}

interface GetTotalAddressCountArgs {
  currencyInfo: EngineCurrencyInfo
  walletInfo: EdgeWalletInfo
  processor: Processor
}

const getTotalAddressCount = async (args: GetTotalAddressCountArgs): Promise<number> => {
  const {
    walletInfo,
  } = args

  const walletFormats = getWalletSupportedFormats(walletInfo)

  let count = 0
  for (const format of walletFormats) {
    count += await getFormatAddressCount({ ...args, format })
  }
  return count
}

interface GetFormatAddressCountArgs extends GetTotalAddressCountArgs {
  format: CurrencyFormat
}

const getFormatAddressCount = async (args: GetFormatAddressCountArgs): Promise<number> => {
  const {
    format,
    currencyInfo,
    processor
  } = args

  let count = 0

  const branches = getFormatSupportedBranches(format)
  for (const branch of branches) {
    let branchCount = await processor.getNumAddressesFromPathPartition({ format, changeIndex: branch })
    if (branchCount < currencyInfo.gapLimit) branchCount = currencyInfo.gapLimit
    count += branchCount
  }

  return count
}

interface FindLastUsedIndexArgs extends FormatArgs {
}

/**
 * Assumes the last used index is:
 *    addressCount - gapLimit - 1
 * Verified by checking the ~used~ flag on the address and then checking newer ones.
 * @param args - FindLastUsedIndexArgs
 */
const findLastUsedIndex = async (args: FindLastUsedIndexArgs): Promise<number> => {
  const {
    format,
    branch,
    currencyInfo,
    processor,
  } = args

  const path: AddressPath = {
    format,
    changeIndex: branch,
    addressIndex: 0 // tmp
  }
  const addressCount = await processor.getNumAddressesFromPathPartition(path)
  // Get the assumed last used index
  path.addressIndex = Math.max(addressCount - currencyInfo.gapLimit - 1, 0)

  for (let i = path.addressIndex; i < addressCount; i++) {
    const addressData = await fetchAddressDataByPath({ ...args, path })
    if (addressData.used) {
      path.addressIndex = i
    }
  }

  return path.addressIndex
}

interface FetchAddressDataByPath extends CommonArgs {
  path: AddressPath
}

const fetchAddressDataByPath = async (args: FetchAddressDataByPath): Promise<IAddress> => {
  const {
    path,
    processor,
    walletTools
  } = args

  const scriptPubkey =
    await processor.fetchScriptPubkeyByPath(path) ??
    walletTools.getScriptPubkey(path).scriptPubkey

  const addressData = await processor.fetchAddressByScriptPubkey(scriptPubkey)
  if (!addressData) throw new Error('Address data unknown')
  return addressData
}

interface GetFreshAddressArgs extends FormatArgs {
}

interface GetFreshAddressReturn {
  address: string
  legacyAddress: string
}

const internalGetFreshAddress = async (args: GetFreshAddressArgs): Promise<GetFreshAddressReturn> => {
  const {
    format,
    branch,
    walletTools,
    processor
  } = args

  const path: AddressPath = {
    format,
    changeIndex: branch,
    addressIndex: await findLastUsedIndex(args) + 1
  }
  let scriptPubkey = await processor.fetchScriptPubkeyByPath(path)
  scriptPubkey = scriptPubkey ?? (await walletTools.getScriptPubkey(path)).scriptPubkey
  if (!scriptPubkey) {
    throw new Error('Unknown address path')
  }
  return walletTools.scriptPubkeyToAddress({
    scriptPubkey,
    format
  })
}

interface ProcessFormatAddressesArgs extends FormatArgs {
}

const processFormatAddresses = async (args: ProcessFormatAddressesArgs) => {
  const branches = getFormatSupportedBranches(args.format)
  for (const branch of branches) {
    await processPathAddresses({ ...args, changeIndex: branch })
  }
}

interface ProcessPathAddressesArgs extends ProcessFormatAddressesArgs {
  changeIndex: number
}

const processPathAddresses = async (args: ProcessPathAddressesArgs) => {
  const {
    walletTools,
    processor,
    format,
    changeIndex
  } = args

  const addressCount = await processor.getNumAddressesFromPathPartition({ format, changeIndex })
  for (let i = 0; i < addressCount; i++) {
    const path: AddressPath = {
      format,
      changeIndex,
      addressIndex: i
    }
    let scriptPubkey = await processor.fetchScriptPubkeyByPath(path)
    scriptPubkey = scriptPubkey ?? walletTools.getScriptPubkey(path).scriptPubkey
    const { address } = walletTools.scriptPubkeyToAddress({
      scriptPubkey,
      format
    })

    await processAddress({ ...args, address })
  }
}

interface ProcessAddressArgs extends FormatArgs {
  address: string
}

const processAddress = async (args: ProcessAddressArgs) => {
  const {
    address,
    blockBook,
    addressesToWatch,
    onAddressChecked
  } = args

  const firstProcess = !addressesToWatch.has(address)
  if (firstProcess) {
    addressesToWatch.add(address)
    blockBook.watchAddresses(Array.from(addressesToWatch), async (response) => {
      await setLookAhead(args)
      await processAddress({ ...args, address: response.address })
    })
  }

  await Promise.all([
    processAddressTransactions(args),
    processAddressUtxos(args)
  ])

  firstProcess && onAddressChecked()
}

interface ProcessAddressTxsArgs extends FormatArgs {
  address: string
  page?: number
  networkQueryVal?: number
}

const processAddressTransactions = async (args: ProcessAddressTxsArgs): Promise<void> => {
  const {
    address,
    page = 1,
    processor,
    walletTools,
    blockBook
  } = args

  const scriptPubkey = walletTools.addressToScriptPubkey(address)
  const addressData = await processor.fetchAddressByScriptPubkey(scriptPubkey)
  let networkQueryVal = args.networkQueryVal ?? addressData?.networkQueryVal
  const {
    transactions = [],
    txs,
    unconfirmedTxs,
    totalPages
  } = await blockBook.fetchAddress(address, {
    details: 'txs',
    from: networkQueryVal,
    perPage: BLOCKBOOK_TXS_PER_PAGE,
    page
  })

  // If address is used and previously not marked as used, mark as used.
  const used = txs > 0 || unconfirmedTxs > 0
  if (used && !addressData?.used && page === 1) {
    await processor.updateAddressByScriptPubkey(scriptPubkey, {
      used
    })
    await setLookAhead(args)
  }

  for (const rawTx of transactions) {
    const tx = processRawTx({ ...args, tx: rawTx })
    await processor.saveTransaction(tx)
  }

  if (page < totalPages) {
    await processAddressTransactions({
      ...args,
      page: page + 1,
      networkQueryVal
    })
  }
}

interface ProcessRawTxArgs extends CommonArgs {
  tx: ITransaction
}

const processRawTx = (args: ProcessRawTxArgs): IProcessorTransaction => {
  const { tx, currencyInfo } = args
  return {
    txid: tx.txid,
    hex: tx.hex,
    // Blockbook can return a blockHeight of -1 when the tx is pending in the mempool
    blockHeight: tx.blockHeight > 0 ? tx.blockHeight : 0,
    date: tx.blockTime,
    fees: tx.fees,
    inputs: tx.vin.map((input) => ({
      txId: input.txid,
      outputIndex: input.vout, // case for tx `fefac8c22ba1178df5d7c90b78cc1c203d1a9f5f5506f7b8f6f469fa821c2674` no `vout` for input
      address: input.addresses[0],
      scriptPubkey: validScriptPubkeyFromAddress({
        address: input.addresses[0],
        coin: currencyInfo.network,
        network: args.network
      }),
      amount: input.value
    })),
    outputs: tx.vout.map((output) => ({
      index: output.n,
      address: output.addresses[0],
      scriptPubkey: output.hex ?? validScriptPubkeyFromAddress({
        address: output.addresses[0],
        coin: currencyInfo.network,
        network: args.network
      }),
      amount: output.value
    })),
    ourIns: [],
    ourOuts: [],
    ourAmount: '0'
  }
}

interface FetchTransactionArgs extends CommonArgs {
  txid: string
}

const fetchTransaction = async (args: FetchTransactionArgs): Promise<IProcessorTransaction> => {
  const { txid, processor, blockBook } = args
  let tx = await processor.fetchTransaction(txid)
  if (!tx) {
    const rawTx = await blockBook.fetchTransaction(txid)
    tx = processRawTx({ ...args, tx: rawTx })
  }
  return tx
}

interface ProcessAddressUtxosArgs extends FormatArgs {
  address: string
}

const processAddressUtxos = async (args: ProcessAddressUtxosArgs): Promise<void> => {
  const {
    address,
    currencyInfo,
    walletTools,
    processor,
    blockBook,
    emitter,
    mutexor,
  } = args

  const scriptPubkey = walletTools.addressToScriptPubkey(address)
  await mutexor(`utxos-${scriptPubkey}`).runExclusive(async () => {
    let newBalance = '0'
    let oldBalance = '0'
    const currentUtxos = await processor.fetchUtxosByScriptPubkey(scriptPubkey)
    const currentUtxoIds = new Set(
      currentUtxos.map(({ id, value }) => {
        oldBalance = bs.add(oldBalance, value)
        return id
      })
    )

    const addressData = await processor.fetchAddressByScriptPubkey(scriptPubkey)

    const toAdd = new Set<IUTXO>()
    const rawUtxos = await blockBook.fetchAddressUtxos(address)
    for (const rawUtxo of rawUtxos) {
      const id = `${rawUtxo.txid}_${rawUtxo.vout}`
      if (currentUtxoIds.has(id)) {
        currentUtxoIds.delete(id)
      } else {
        const utxo = await processRawUtxo({
          ...args,
          id,
          utxo: rawUtxo,
          address: addressData!,
        })
        toAdd.add(utxo)
      }
    }

    for (const utxo of toAdd) {
      await processor.saveUtxo(utxo)
      newBalance = bs.add(newBalance, utxo.value)
    }
    for (const id of currentUtxoIds) {
      const utxo = await processor.removeUtxo(id)
      newBalance = bs.sub(newBalance, utxo.value)
    }

    const diff = bs.sub(newBalance, oldBalance)
    if (diff !== '0') {
      emitter.emit(EmitterEvent.BALANCE_CHANGED, currencyInfo.currencyCode, diff)

      await processor.updateAddressByScriptPubkey(scriptPubkey, {
        balance: newBalance,
        used: true
      })
      await setLookAhead(args)
    }
  })
}

interface ProcessRawUtxoArgs extends FormatArgs {
  utxo: IAccountUTXO
  id: string
  address: IAddress
}

const processRawUtxo = async (args: ProcessRawUtxoArgs): Promise<IUTXO> => {
  const {
    utxo,
    id,
    address,
    format,
    walletTools
  } = args

  let scriptType: ScriptTypeEnum
  let script: string
  let redeemScript: string | undefined
  switch (currencyFormatToPurposeType(format)) {
    case BIP43PurposeTypeEnum.Airbitz:
    case BIP43PurposeTypeEnum.Legacy:
      script = (await fetchTransaction({ ...args, txid: utxo.txid })).hex
      scriptType = ScriptTypeEnum.p2pkh
      break
    case BIP43PurposeTypeEnum.WrappedSegwit:
      script = address.scriptPubkey
      scriptType = ScriptTypeEnum.p2wpkhp2sh
      redeemScript = walletTools.getScriptPubkey(address.path!).redeemScript
      break
    case BIP43PurposeTypeEnum.Segwit:
      script = address.scriptPubkey
      scriptType = ScriptTypeEnum.p2wpkh
      break
  }

  return {
    id,
    txid: utxo.txid,
    vout: utxo.vout,
    value: utxo.value,
    scriptPubkey: address.scriptPubkey,
    script,
    redeemScript,
    scriptType,
    blockHeight: utxo.height ?? 0
  }
}
