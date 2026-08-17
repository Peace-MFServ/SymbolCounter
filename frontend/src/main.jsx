import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app'
import './index.css'
import { AuthProvider } from './auth'

ReactDOM.createRoot(document.getElementById('root')).render(
  <AuthProvider>
    <App />
  </AuthProvider>
)
