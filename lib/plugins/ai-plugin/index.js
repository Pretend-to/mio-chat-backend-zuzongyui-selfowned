import Plugin from '../../plugin.js'

export default class AIPlugin extends Plugin {
  constructor() {
    super({ importMetaUrl: import.meta.url })
  }

  getInitialConfig() {
    return {}
  }
}
