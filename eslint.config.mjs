import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypeScript from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    rules: {
      // R3 deliberately keeps stable editor refs and synchronous UI state resets
      // to preserve the timeline/editor interaction contract.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'node_modules/**',
    'src-tauri/target/**',
    '_audit/**',
    '.task-package/**',
    'artifacts/**',
    'public/schedule-assets/**',
    // Native test libraries include WebView's generated browser profile.
    'test-data/**',
  ]),
])
