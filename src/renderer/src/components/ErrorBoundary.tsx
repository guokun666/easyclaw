import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  errorInfo: ErrorInfo | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = {
    error: null,
    errorInfo: null
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      error,
      errorInfo: null
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Renderer crashed:', error, errorInfo)
    this.setState({
      error,
      errorInfo
    })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <div className="min-h-screen bg-bg text-text px-8 py-10 font-mono overflow-auto">
        <div className="max-w-4xl mx-auto space-y-4">
          <div>
            <h1 className="text-xl font-bold text-error">页面发生异常</h1>
            <p className="text-sm text-text-muted mt-2">
              请截图这页内容，我可以继续根据具体报错修。
            </p>
          </div>

          <div className="glass-card p-4 space-y-3">
            <div>
              <div className="text-xs text-text-muted uppercase tracking-wide">Error</div>
              <pre className="mt-2 whitespace-pre-wrap break-words text-sm">
                {this.state.error.stack || this.state.error.message}
              </pre>
            </div>

            {this.state.errorInfo?.componentStack && (
              <div>
                <div className="text-xs text-text-muted uppercase tracking-wide">
                  Component Stack
                </div>
                <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
                  {this.state.errorInfo.componentStack}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }
}
