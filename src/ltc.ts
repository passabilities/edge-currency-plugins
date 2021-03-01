import { EdgeCorePluginOptions, EdgeCorePlugins } from 'edge-core-js'

import { makeCurrencyPlugin } from './common/plugin/makeCurrencyPlugin'
import { info } from './common/utxobased/info/litecoin'

const plugin = {
  [info.pluginId]: (options: EdgeCorePluginOptions) =>
    makeCurrencyPlugin(options, info),
} as EdgeCorePlugins

if (typeof window !== 'undefined') {
  window.addEdgeCorePlugins?.(plugin)
}

export default plugin
