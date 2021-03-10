import {
  EdgeCurrencyCodeOptions,
  EdgeCurrencyEngine,
  EdgeDataDump,
  EdgeFreshAddress,
  EdgeGetTransactionsOptions,
  EdgePaymentProtocolInfo,
  EdgeSpendInfo,
  EdgeTokenInfo,
  EdgeTransaction,
  EdgeTxidMap,
  JsonObject
} from 'edge-core-js'
import { navigateDisklet } from 'disklet'
import * as bs from 'biggystring'
import * as bitcoin from 'altcoin-js'

import { EmitterEvent, EngineConfig } from '../../plugin/types'
import { makeUtxoEngineState } from './makeUtxoEngineState'
import { makeProcessor } from '../db/makeProcessor'
import { makeTx, MakeTxTarget, signTx } from '../keymanager/keymanager'
import { Fees, makeFees } from '../../fees'
import { makeBlockBook } from '../network/BlockBook'
import { makeUtxoWalletTools } from './makeUtxoWalletTools'
import { fetchMetadata, setMetadata } from '../../plugin/utils'
import { fetchOrDeriveXprivFromKeys, getWalletFormat, getWalletSupportedFormats, getXprivKey } from './utils'
import { IProcessorTransaction } from '../db/types'
import { fromEdgeTransaction, toEdgeTransaction } from '../db/Models/ProcessorTransaction'
import { createPayment, getPaymentDetails, sendPayment } from './paymentRequest'
import { makeMutexor } from './mutexor'
import { FEES_DISKLET_PATH } from '../../constants'

export async function makeUtxoEngine(config: EngineConfig): Promise<EdgeCurrencyEngine> {
  const {
    network,
    currencyInfo,
    walletInfo,
    options: {
      walletLocalDisklet,
      walletLocalEncryptedDisklet,
      emitter
    },
    io
  } = config

  const mutexor = makeMutexor()

  // Merge in the xpriv into the local copy of wallet keys
  walletInfo.keys[getXprivKey({ coin: currencyInfo.network })] = await fetchOrDeriveXprivFromKeys({
    keys: walletInfo.keys,
    walletLocalEncryptedDisklet,
    coin: currencyInfo.network,
    network
  })

  const walletTools = makeUtxoWalletTools({
    keys: walletInfo.keys,
    coin: currencyInfo.network,
    network
  })

  const fees = await makeFees({
    disklet: navigateDisklet(walletLocalDisklet, FEES_DISKLET_PATH),
    currencyInfo,
    io,
    log: config.options.log
  })

  const blockBook = makeBlockBook({ emitter })
  const metadata = await fetchMetadata(walletLocalDisklet)
  const processor = await makeProcessor({ disklet: walletLocalDisklet, emitter })
  const state = makeUtxoEngineState({
    ...config,
    walletTools,
    processor,
    blockBook,
    metadata
  })

  emitter.on(EmitterEvent.PROCESSOR_TRANSACTION_CHANGED, (tx: IProcessorTransaction) => {
    emitter.emit(EmitterEvent.TRANSACTIONS_CHANGED, ([
      toEdgeTransaction(tx, currencyInfo.currencyCode)
    ]))
  })

  emitter.on(EmitterEvent.BALANCE_CHANGED, async (currencyCode: string, nativeBalance: string) => {
    await mutexor('balanceChanged').runExclusive(async () => {
      metadata.balance = nativeBalance
      await setMetadata(walletLocalDisklet, metadata)
    })
  })

  emitter.on(EmitterEvent.BLOCK_HEIGHT_CHANGED, async (height: number) => {
    metadata.lastSeenBlockHeight = height
    await setMetadata(walletLocalDisklet, metadata)
  })

  const fns: EdgeCurrencyEngine = {
    async startEngine(): Promise<void> {
      await blockBook.connect()
      const { bestHeight } = await blockBook.fetchInfo()
      emitter.emit(EmitterEvent.BLOCK_HEIGHT_CHANGED, bestHeight)

      await fees.start()
      await state.start()
    },

    async killEngine(): Promise<void> {
      await state.stop()
      fees.stop()
      await blockBook.disconnect()
    },

    getBalance(opts: EdgeCurrencyCodeOptions): string {
      return metadata.balance
    },

    getBlockHeight(): number {
      return metadata.lastSeenBlockHeight
    },

    addCustomToken(_token: EdgeTokenInfo): Promise<unknown> {
      return Promise.resolve(undefined)
    },

    async addGapLimitAddresses(_addresses: string[]): Promise<void> {
    },

    async broadcastTx(transaction: EdgeTransaction): Promise<EdgeTransaction> {
      const { otherParams } = transaction
      if (
        otherParams?.paymentProtocolInfo?.payment != null &&
        otherParams?.paymentProtocolInfo?.paymentUrl != null
      ) {
        const paymentAck = await sendPayment(
          io.fetch,
          otherParams.paymentProtocolInfo.paymentUrl,
          otherParams.paymentProtocolInfo.payment
        )
        if (typeof paymentAck === 'undefined') {
          throw new Error(
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            `Error when sending to ${otherParams.paymentProtocolInfo.paymentUrl}`
          )
        }
      }
      await blockBook.broadcastTx(transaction)
      return transaction
    },

    changeUserSettings(_settings: JsonObject): Promise<unknown> {
      return Promise.resolve(undefined)
    },

    disableTokens(_tokens: string[]): Promise<unknown> {
      return Promise.resolve(undefined)
    },

    async dumpData(): Promise<EdgeDataDump> {
      return {
        walletId: walletInfo.id.split(' - ')[0],
        walletType: walletInfo.type,
        data: {
          walletInfo: {
            walletFormat: getWalletFormat(walletInfo),
            walletFormatsSupported: getWalletSupportedFormats(walletInfo),
            pluginType: currencyInfo.pluginId,
          },
          state: await processor.dumpData()
        }
      }
    },

    enableTokens(_tokens: string[]): Promise<unknown> {
      return Promise.resolve(undefined)
    },

    getDisplayPrivateSeed(): string | null {
      return null
    },

    getDisplayPublicSeed(): string | null {
      return null
    },

    getEnabledTokens(): Promise<string[]> {
      return Promise.resolve([])
    },

    getFreshAddress(_opts: EdgeCurrencyCodeOptions): Promise<EdgeFreshAddress> | EdgeFreshAddress {
      return state.getFreshAddress()
    },

    getNumTransactions(_opts: EdgeCurrencyCodeOptions): number {
      return 0
    },

    async getPaymentProtocolInfo(paymentProtocolUrl: string): Promise<EdgePaymentProtocolInfo> {
      return await getPaymentDetails(
        paymentProtocolUrl,
        network,
        currencyInfo.currencyCode,
        io.fetch
      )
    },

    getTokenStatus(_token: string): boolean {
      return false
    },

    async getTransactions(opts: EdgeGetTransactionsOptions): Promise<EdgeTransaction[]> {
      const txs = await processor.fetchTransactions(opts)
      return txs.map((tx) => toEdgeTransaction(tx, currencyInfo.currencyCode))
    },

    // @ts-ignore
    async isAddressUsed(address: string): Promise<boolean> {
      const scriptPubkey = walletTools.addressToScriptPubkey(address)
      const addressData = await processor.fetchAddressByScriptPubkey(scriptPubkey)
      return !!addressData?.used
    },

    async makeSpend(edgeSpendInfo: EdgeSpendInfo): Promise<EdgeTransaction> {
      const targets: MakeTxTarget[] = []
      const ourReceiveAddresses: string[] = []
      for (const target of edgeSpendInfo.spendTargets) {
        if (!target.publicAddress || !target.nativeAmount) {
          throw new Error('Invalid spend target')
        }

        const scriptPubkey = walletTools.addressToScriptPubkey(target.publicAddress)
        if (await processor.hasSPubKey(scriptPubkey)) {
          ourReceiveAddresses.push(target.publicAddress)
        }

        targets.push({
          address: target.publicAddress,
          value: parseInt(target.nativeAmount)
        })
      }

      const freshAddress = await state.getFreshAddress(1)
      const freshChangeAddress = freshAddress.segwitAddress ?? freshAddress.publicAddress
      const utxos = await processor.fetchAllUtxos()
      const feeRate = parseInt(await fees.getRate(edgeSpendInfo))
      const tx = await makeTx({
        utxos,
        targets,
        feeRate,
        coin: currencyInfo.network,
        network,
        rbf: false,
        freshChangeAddress
      })
      if (tx.changeUsed) {
        ourReceiveAddresses.push(freshChangeAddress)
      }

      let nativeAmount = '0'
      for (const output of tx.psbt.txOutputs) {
        const scriptPubkey = output.script.toString('hex')
        const own = await processor.hasSPubKey(scriptPubkey)
        if (!own) {
          nativeAmount = bs.sub(nativeAmount, output.value.toString())
        }
      }

      const networkFee = tx.fee.toString()
      nativeAmount = bs.sub(nativeAmount, networkFee)

      return {
        ourReceiveAddresses,
        otherParams: {
          psbt: tx.psbt.toBase64(),
          edgeSpendInfo
        },
        currencyCode: currencyInfo.currencyCode,
        txid: '',
        date: 0,
        blockHeight: 0,
        nativeAmount,
        networkFee,
        feeRateUsed: {
          satPerVByte: feeRate
        },
        signedTx: ''
      }
    },

    resyncBlockchain(): Promise<unknown> {
      return Promise.resolve(undefined)
    },

    saveTx(tx: EdgeTransaction): Promise<void> {
      return processor.saveTransaction(fromEdgeTransaction(tx), false)
    },

    async signTx(transaction: EdgeTransaction): Promise<EdgeTransaction> {
      const { psbt } = transaction!.otherParams!
      const inputs = bitcoin.Psbt.fromBase64(psbt).txInputs
      const privateKeys = await Promise.all(inputs.map(async ({ hash, index }) => {
        const txid = Buffer.isBuffer(hash) ? hash.reverse().toString('hex') : hash

        const utxo = await processor.fetchUtxo(`${txid}_${index}`)
        if (!utxo) throw new Error('Invalid UTXO')

        const address = await processor.fetchAddressByScriptPubkey(utxo.scriptPubkey)
        if (!address?.path) throw new Error('Invalid script pubkey')

        return walletTools.getPrivateKey(address.path)
      }))
      transaction.signedTx = await signTx({
        psbt,
        coin: currencyInfo.network,
        privateKeys
      })
      const { edgeSpendInfo } = transaction.otherParams
      const { paymentProtocolInfo } = edgeSpendInfo.otherParams
      if (paymentProtocolInfo != null) {
        const payment = createPayment(
          transaction.signedTx,
          transaction.currencyCode
        )
        Object.assign(transaction.otherParams, {
          paymentProtocolInfo: { ...paymentProtocolInfo, payment }
        })
      }

      return transaction
    },

    sweepPrivateKeys(_spendInfo: EdgeSpendInfo): Promise<EdgeTransaction> {
      // @ts-ignore
      return Promise.resolve(undefined)
    }
  }

  return fns
}
