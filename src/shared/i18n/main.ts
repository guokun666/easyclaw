import i18next from 'i18next'

import zhCommon from './locales/zh/common.json'
import zhMain from './locales/zh/main.json'

const i18nMain = i18next.createInstance()

i18nMain.init({
  resources: {
    zh: { common: zhCommon, main: zhMain }
  },
  lng: 'zh',
  fallbackLng: 'zh',
  defaultNS: 'main',
  ns: ['common', 'main'],
  interpolation: { escapeValue: false }
})

export const t = i18nMain.t.bind(i18nMain)

export const initI18nMain = async (): Promise<void> => {
  await i18nMain.changeLanguage('zh')
}

export default i18nMain
