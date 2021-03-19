import { Disklet } from 'disklet'
import { Mutex } from 'async-mutex'
import * as bs from 'biggystring'

import { Emitter, EmitterEvent, LocalWalletMetadata } from './types'

const metadataPath = `metadata.json`

interface MetadataConfig {
  disklet: Disklet
  emitter: Emitter
}

export const makeMetadata = async (config: MetadataConfig): Promise<LocalWalletMetadata> => {
  const {
    disklet,
    emitter
  } = config

  const mutex = new Mutex()

  const cache: LocalWalletMetadata = await fetchMetadata(disklet)

  emitter.on(EmitterEvent.ADDRESS_BALANCE_CHANGED, async (currencyCode: string, balanceDiff: string) => {
    await mutex.runExclusive(async () => {
      cache.balance = bs.add(cache.balance, balanceDiff)
      emitter.emit(EmitterEvent.WALLET_BALANCE_CHANGED, currencyCode, cache.balance)
      await setMetadata(disklet, cache)
    })
  })

  emitter.on(EmitterEvent.BLOCK_HEIGHT_CHANGED, async (height: number) => {
    await mutex.runExclusive(async () => {
      cache.lastSeenBlockHeight = height
      await setMetadata(disklet, cache)
    })
  })

  return {
    get balance() { return cache.balance },
    get lastSeenBlockHeight() { return cache.lastSeenBlockHeight },
  }
}

export const fetchMetadata = async (disklet: Disklet): Promise<LocalWalletMetadata> => {
  try {
    const dataStr = await disklet.getText(metadataPath)
    return JSON.parse(dataStr)
  } catch {
    const data: LocalWalletMetadata = {
      balance: '0',
      lastSeenBlockHeight: 0
    }
    await setMetadata(disklet, data)
    return data
  }
}

export const setMetadata = async (disklet: Disklet, data: LocalWalletMetadata): Promise<void> => {
  await disklet.setText(metadataPath, JSON.stringify(data))
}
