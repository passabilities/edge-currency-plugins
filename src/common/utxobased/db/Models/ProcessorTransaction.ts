import { EdgeTransaction } from 'edge-core-js'

import { IProcessorTransaction } from '../types'
import { UTXOPluginWalletTools } from '../../engine/makeUtxoWalletTools'
import { Processor } from '../makeProcessor'

export const fromEdgeTransaction = (tx: EdgeTransaction): IProcessorTransaction => ({
  txid: tx.txid,
  hex: tx.signedTx,
  blockHeight: tx.blockHeight,
  date: tx.date,
  fees: tx.networkFee,
  inputs: tx.otherParams?.inputs ?? [],
  outputs: tx.otherParams?.outputs ?? [],
  ourIns: tx.otherParams?.ourIns ?? [],
  ourOuts: tx.otherParams?.ourOuts ?? [],
  ourAmount: tx.nativeAmount ?? '0'
})

interface ToEdgeTransactionArgs {
  tx: IProcessorTransaction
  currencyCode: string
  walletTools: UTXOPluginWalletTools
  processor: Processor
}

export const toEdgeTransaction = async (args: ToEdgeTransactionArgs): Promise<EdgeTransaction> => ({
  currencyCode: args.currencyCode,
  txid: args.tx.txid,
  blockHeight: args.tx.blockHeight,
  date: args.tx.date,
  nativeAmount: args.tx.ourAmount,
  networkFee: args.tx.fees,
  signedTx: args.tx.hex,
  ourReceiveAddresses: args.tx.ourOuts.map((i: string) =>
    args.tx.outputs[parseInt(i)].address
  ),
  otherParams: {
    inputs: args.tx.inputs,
    outputs: args.tx.outputs,
    ourIns: args.tx.ourIns,
    ourOuts: args.tx.ourOuts
  }
})
