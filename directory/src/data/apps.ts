export const appData = [
  {
    intents: [],
    icons: [{ icon: 'https://appd.kolbito.com/images/fdc3-logo.png' }],
    images: [
      { url: 'https://appd.kolbito.com/demos/channel-manager/screen-1.png' },
    ],
    start_url: 'https://appd.kolbito.com/demos/channel-manager/',
    appId: 'Channel-Manager',
    description: 'View and manage context on all channels.',
    name: 'Channel-Manager',
    manifest_type: 'web',
    title: 'Channel Manager',
    manifest: 'undefined/manifests/Channel-Manager',
    icon: 'https://appd.kolbito.com/images/fdc3-logo.png',
  },
  {
    intents: [
      {
        name: 'fdc3.ViewQuote',
        display_name: 'View Quote',
        contexts: ['fdc3.instrument'],
      },
      {
        name: 'fdc3.ViewInstrument',
        display_name: 'View Instrument',
        contexts: ['fdc3.instrument'],
      },
    ],
    icons: [{ icon: 'https://www.tradingview.com/static/images/favicon.ico' }],
    images: [
      {
        url: 'https://appd.kolbito.com/demos/tradingview-blotter/screen-1.png',
      },
    ],
    start_url: 'https://appd.kolbito.com/demos/tradingview-blotter/',
    appId: 'TradingViewBlotter',
    description: 'TradingView-based Blotter App',
    name: 'TradingViewBlotter',
    manifest_type: 'web',
    title: 'TradingView Blotter App',
    manifest: 'undefined/manifests/TradingViewBlotter',
    icon: 'https://www.tradingview.com/static/images/favicon.ico',
  },
  {
    intents: [
      {
        name: 'fdc3.ViewNews',
        display_name: 'View News',
        contexts: ['fdc3.instrument'],
      },
    ],
    icons: [{ icon: 'https://newsapi.org/favicon-32x32.png' }],
    images: [{ url: 'https://appd.kolbito.com/demos/news-demo/screen-1.png' }],
    start_url: 'https://appd.kolbito.com/demos/news-demo/',
    appId: 'News-Demo',
    description: 'Demo fdc3 news feed using services from NewsAPI.org',
    name: 'News-Demo',
    manifest_type: 'web',
    title: 'News Feed Demo',
    manifest: 'undefined/manifests/News-Demo',
    icon: 'https://newsapi.org/favicon-32x32.png',
  },
  {
    intents: [
      {
        name: 'fdc3.ViewChart',
        display_name: 'View Chart',
        contexts: ['fdc3.instrument'],
      },
    ],
    icons: [
      { icon: 'https://appd.kolbito.com/demos/tradingview-chart/icon.png' },
    ],
    images: [
      { url: 'https://appd.kolbito.com/demos/tradingview-chart/screen-1.png' },
    ],
    start_url: 'https://appd.kolbito.com/demos/tradingview-chart/',
    appId: 'TradingViewChart',
    description: 'Demo fdc3 chart using widgets from TradingView',
    name: 'TradingViewChart',
    manifest_type: 'web',
    title: 'TradingView Chart',
    manifest: 'undefined/manifests/TradingViewChart',
    icon: 'https://appd.kolbito.com/demos/tradingview-chart/icon.png',
  },
  {
    intents: [
      {
        name: 'fdc3.ViewInstrument',
        display_name: 'View Instrument',
        contexts: ['fdc3.instrument'],
      },
    ],
    icons: [{ icon: 'https://polygon.io/favicon.ico' }],
    images: [
      { url: 'https://appd.kolbito.com/demos/ticker-demo/screen-1.png' },
    ],
    start_url: 'https://appd.kolbito.com/demos/ticker-demo/',
    appId: 'Ticker-Demo',
    description: 'Demo fdc3 company information using services from Polygon.io',
    name: 'Ticker-Demo',
    manifest_type: 'web',
    title: 'Ticker Info Demo',
    manifest: 'undefined/manifests/Ticker-Demo',
    icon: 'https://polygon.io/favicon.ico',
  },
  {
    intents: [],
    icons: [{ icon: 'https://appd.kolbito.com/images/fdc3-logo.png' }],
    images: [
      { url: 'https://appd.kolbito.com/demos/ticker-grid/screen-1.png' },
    ],
    start_url: 'https://appd.kolbito.com/demos/ticker-grid/',
    appId: 'Ticker-Grid',
    description: 'fdc3 enabled grid of the S&P 500',
    name: 'Ticker-Grid',
    manifest_type: 'web',
    title: 'Ticker Grid',
    manifest: 'undefined/manifests/Ticker-Grid',
    icon: 'https://appd.kolbito.com/images/fdc3-logo.png',
  },
];
