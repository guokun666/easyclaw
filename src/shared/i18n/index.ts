import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'

import zhCommon from './locales/zh/common.json'
import zhSteps from './locales/zh/steps.json'
import zhManagement from './locales/zh/management.json'
import zhProviders from './locales/zh/providers.json'

const i18n = i18next.createInstance()

i18n.use(initReactI18next).init({
  resources: {
    zh: { common: zhCommon, steps: zhSteps, management: zhManagement, providers: zhProviders }
  },
  lng: 'zh',
  fallbackLng: 'zh',
  defaultNS: 'common',
  ns: ['common', 'steps', 'management', 'providers'],
  interpolation: { escapeValue: false }
})

export default i18n
