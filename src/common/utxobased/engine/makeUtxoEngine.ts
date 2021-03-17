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
import * as bs from 'biggystring'

import { EmitterEvent, EngineConfig } from '../../plugin/types'
import { makeUtxoEngineState } from './makeUtxoEngineState'
import { makeProcessor } from '../db/makeProcessor'
import { makeTx, MakeTxTarget, signTx } from '../keymanager/keymanager'
import { calculateFeeRate } from './makeSpendHelper'
import { makeBlockBook } from '../network/BlockBook'
import { makeUtxoWalletTools } from './makeUtxoWalletTools'
import { makeMetadata } from '../../plugin/makeMetadata'
import { fetchOrDeriveXprivFromKeys, getWalletFormat, getWalletSupportedFormats, getXprivKey } from './utils'
import { IProcessorTransaction } from '../db/types'
import { fromEdgeTransaction, toEdgeTransaction } from '../db/Models/ProcessorTransaction'
import { createPayment, getPaymentDetails, sendPayment } from './paymentRequest'
import { UTXOTxOtherParams } from './types'

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

  const blockBook = makeBlockBook({ emitter })
  const metadata = await makeMetadata({ disklet: walletLocalDisklet, emitter, })
  const processor = await makeProcessor({ disklet: walletLocalDisklet, emitter })
  const state = makeUtxoEngineState({
    ...config,
    walletTools,
    processor,
    blockBook,
  })

  emitter.on(EmitterEvent.PROCESSOR_TRANSACTION_CHANGED, async (tx: IProcessorTransaction) => {
    emitter.emit(EmitterEvent.TRANSACTIONS_CHANGED, [
      await toEdgeTransaction({
        tx,
        currencyCode: currencyInfo.currencyCode,
        walletTools,
        processor
      })
    ])
  })

  const fns: EdgeCurrencyEngine = {
    async startEngine(): Promise<void> {
      await blockBook.connect()

      const { bestHeight } = await blockBook.fetchInfo()
      emitter.emit(EmitterEvent.BLOCK_HEIGHT_CHANGED, bestHeight)

      await state.start()
    },

    async killEngine(): Promise<void> {
      await state.stop()
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

    addGapLimitAddresses(addresses: string[]): undefined {
      state.addGapLimitAddresses(addresses)
      return
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
      return processor.getNumTransactions()
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
      return await Promise.all(txs.map((tx: IProcessorTransaction) =>
        toEdgeTransaction({
          tx,
          currencyCode: currencyInfo.currencyCode,
          walletTools,
          processor
        })
      ))
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
      const feeRate = parseInt(calculateFeeRate(currencyInfo, edgeSpendInfo))
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
      for (const output of tx.outputs) {
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
          psbt: {
            base64: tx.psbtBase64,
            inputs: tx.inputs
          },
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
      return processor.saveTransaction(fromEdgeTransaction(tx))
    },

    async signTx(transaction: EdgeTransaction): Promise<EdgeTransaction> {
      const { psbt, edgeSpendInfo }: Partial<UTXOTxOtherParams> = transaction.otherParams ?? {}
      if (!psbt || !edgeSpendInfo) throw new Error('Invalid transaction data')

      const privateKeys = await Promise.all(
        psbt.inputs.map(async ({ hash, index }) => {
          const txid = Buffer.isBuffer(hash) ? hash.reverse().toString('hex') : hash

          const utxo = await processor.fetchUtxo(`${txid}_${index}`)
          if (!utxo) throw new Error('Invalid UTXO')

          const address = await processor.fetchAddressByScriptPubkey(utxo.scriptPubkey)
          if (!address?.path) throw new Error('Invalid script pubkey')

          return walletTools.getPrivateKey(address.path)
        })
      )
      const signedTx = await signTx({
        psbtBase64: psbt.base64,
        coin: currencyInfo.network,
        privateKeys
      })
      transaction.txid = signedTx.id
      transaction.signedTx = signedTx.hex

      const { paymentProtocolInfo } = transaction.otherParams?.edgeSpendInfo?.otherParams ?? {}
      if (paymentProtocolInfo != null) {
        const payment = createPayment(
          transaction.signedTx,
          transaction.currencyCode
        )
        Object.assign(transaction.otherParams, {
          paymentProtocolInfo: {
            ...paymentProtocolInfo,
            payment
          }
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
