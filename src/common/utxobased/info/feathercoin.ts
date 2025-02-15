import { EngineCurrencyInfo, EngineCurrencyType } from '../../plugin/types'
import { imageServerUrl } from './constants'


export const info: EngineCurrencyInfo = {
  currencyType: EngineCurrencyType.UTXO,
  coinType: 8,
  formats: ['bip49', 'bip84', 'bip44', 'bip32'],
  network: 'feathercoin',
  pluginId: 'feathercoin',
  walletType: 'wallet:feathercoin',
  displayName: 'Feathercoin',
  currencyCode: 'FTC',
  gapLimit: 10,
  defaultFee: 1000,
  feeUpdateInterval: 60000,
  customFeeSettings: ['satPerByte'],
  simpleFeeSettings: {
    highFee: '1200',
    lowFee: '400',
    standardFeeLow: '600',
    standardFeeHigh: '800',
    standardFeeLowAmount: '2000000000',
    standardFeeHighAmount: '98100000000'
  },
  denominations: [
    { name: 'FTC', multiplier: '100000000', symbol: 'F' },
    { name: 'mFTC', multiplier: '100000', symbol: 'mF' }
  ],

  // Configuration options:
  defaultSettings: {
    customFeeSettings: ['satPerByte'],
    electrumServers: [
      'electrum://electrumx-ch-1.feathercoin.ch:50001',
      'electrum://electrumx-de-2.feathercoin.ch:50001',
      'electrum://electrumxftc.trezarcoin.com:50001',
      'electrum://electrum.feathercoin.network:50001'
    ],
    disableFetchingServers: false
  },
  metaTokens: [],

  // Explorers:
  addressExplorer: 'https://fsight.chain.tips/address/%s',
  blockExplorer: 'https://fsight.chain.tips/block/%s',
  transactionExplorer: 'https://fsight.chain.tips/tx/%s',

  // Images:
  symbolImage: `${imageServerUrl}/feathercoin-logo-solo-64.png`,
  symbolImageDarkMono: `${imageServerUrl}/feathercoin-logo-solo-64.png`
}
