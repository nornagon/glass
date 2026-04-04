import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { RepoContext } from '@automerge/react'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './index.css'
import { repo } from './model/repo'

registerSW({
  immediate: true,
})

const preventSafariGesture = (event: Event) => {
  event.preventDefault()
}

document.addEventListener('gesturestart', preventSafariGesture)
document.addEventListener('gesturechange', preventSafariGesture)
document.addEventListener('gestureend', preventSafariGesture)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="boot-screen">Loading room...</div>}>
      <RepoContext.Provider value={repo}>
        <App />
      </RepoContext.Provider>
    </Suspense>
  </StrictMode>,
)
