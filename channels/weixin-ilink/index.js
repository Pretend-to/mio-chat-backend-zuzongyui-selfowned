import { WeixinIlinkChannel } from './WeixinIlinkChannel.js'
import { weixinIlinkOneBotsBridge } from './OneBotsBridge.js'

export const weixinIlinkAdapter = {
  id: 'weixin-ilink',
  aliases: [
    'wechat',
    'wechat-clawbot',
    'onebot',
    'onebots',
    'onebots:wechat-clawbot',
    'onebots-wechat-clawbot',
  ],
  runtime: 'onebots',
  protocol: 'onebot.v12',
  name: '微信 iLink',
  description: '通过 OneBots 的微信 ClawBot 底座接入微信 iLink。',
  icon: '💚',
  auth: { type: 'qrcode', label: '微信扫码绑定' },
  capabilities: {
    detailTypes: ['private'],
    media: ['image', 'file'],
    markdown: true,
  },
  defaults: { agentId: 'wechat-master', name: '微信助手' },
  configSchema: [
    {
      key: 'outbound_text_format',
      label: '文本格式',
      type: 'select',
      default: 'markdown',
      options: [
        { label: 'Markdown', value: 'markdown' },
        { label: '纯文本', value: 'plain' },
      ],
    },
  ],
  onebots: {
    platform: 'wechat-clawbot',
    package: '@onebots/adapter-wechat-clawbot',
    bridge: weixinIlinkOneBotsBridge,
  },
  createChannel(options) {
    return new WeixinIlinkChannel(options)
  },
}

export { WeixinIlinkChannel } from './WeixinIlinkChannel.js'
export { normalizeIlinkInboundPacket, weixinIlinkOneBotsBridge } from './OneBotsBridge.js'
export default weixinIlinkAdapter
