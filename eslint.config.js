import tseslint from 'typescript-eslint'
import neverthrow from './eslint-plugins/must-use-result.js'

export default tseslint.config({
  files: ['packages/*/src/**/*.ts'],
  ignores: ['**/*.test.ts', '**/smoke.ts'],
  extends: [tseslint.configs.base],
  plugins: { neverthrow },
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  rules: {
    'neverthrow/must-use-result': 'error',
  },
})
