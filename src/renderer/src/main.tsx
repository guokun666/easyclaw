import './assets/main.css'

import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'

const initApp = async (): Promise<void> => {
  await import('@shared/i18n')
  const debugMinimal = new URLSearchParams(window.location.search).get('debugMinimal') === '1'
  const debugMode = new URLSearchParams(window.location.search).get('debugMode') ?? undefined

  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      {debugMinimal ? (
        <div
          style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#080c18',
            color: '#f0eef6',
            fontSize: 24,
            fontFamily: 'sans-serif'
          }}
        >
          EasyClaw Debug Minimal
        </div>
      ) : (
        <App debugMode={debugMode} />
      )}
    </ErrorBoundary>
  )
}

initApp()
