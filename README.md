# Pomodoro Timer
Fun little react.js microproject!

## SVG dependency validation

The supported configuration is the non-ejected Create React App project. Scoped
overrides select SVGR 8.1.0 and patched SVGO 3.3.5 / 2.8.4 while preserving CRA's
SVG URL and named ReactComponent imports.

Run these checks from the repository root with Node.js 18 or newer:

```sh
npm ci
npm run test:svg
CI=true npm test -- --watchAll=false --runInBand
npm run build
```

The SVG checks exercise both installed optimizers with script-removal bypass
inputs and benign controls, CSS data URLs, and CRA's actual SVG loader including
props, title, and ref forwarding. CRA disables SVGO in its component loader;
these checks do not make SVG optimization a general-purpose sanitizer.

`npm run eject` requires a separate migration of the generated project's direct
SVG loader/optimizer dependencies and this test harness. Ejection removes the
`react-scripts` dependency that scopes these overrides and copies CRA's original
loader dependency range. That generated configuration is not validated by this
change and must not be assumed to retain the patched versions.

Yarn 1 users can use `yarn install --frozen-lockfile`, `yarn test:svg`,
`CI=true yarn test --watchAll=false --runInBand`, and `yarn build`. Keep
`resolutions` and `yarn.lock` aligned with the npm overrides and lockfile.
