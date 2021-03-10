import { EdgeIo, EdgeLog, EdgeSpendInfo } from 'edge-core-js'
import { Disklet } from 'disklet'

import { EngineCurrencyInfo, SimpleFeeSettings } from './plugin/types'
import { makeMemlet, Memlet } from 'memlet'

const FEES_PATH = 'fees.json'

interface MakeFeesConfig {
  disklet: Disklet
  currencyInfo: EngineCurrencyInfo
}

export interface Fees {
}

export const makeFees = async (config: MakeFeesConfig): Promise<Fees> => {
  const {
    currencyInfo,
  } = config

  const memlet = makeMemlet(config.disklet)

  let fees: SimpleFeeSettings = {
    ...currencyInfo.simpleFeeSettings,
    ...await fetchCachedFees(memlet),
  }

  return {}
}

const fetchCachedFees = async (memlet: Memlet): Promise<SimpleFeeSettings> =>
  memlet.getJson(FEES_PATH)
    .catch(() => ({})) // Return empty object on error

const cacheFees = async (memlet: Memlet, fees: SimpleFeeSettings): Promise<void> =>
  await memlet.setJson(FEES_PATH, fees)
