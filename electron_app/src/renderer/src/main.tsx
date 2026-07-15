import React from 'react'
import ReactDOM from 'react-dom/client'
import { MainApp } from './App'
import { OverlayApp } from './OverlayApp'
import './styles.css'

const route = window.location.hash.replace(/^#\/?/, '')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {route === 'overlay' ? <OverlayApp /> : <MainApp />}
  </React.StrictMode>
)
