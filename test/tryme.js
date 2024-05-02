import {debounce} from "../throttle.js"

async function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

let count = 0

function handler() {
  console.log(++count)
}

// const throttle = new pThrottle({ limit: 5, interval: 1000 })

const debouncedHandler = debounce(handler, 500, {maxWait: 1000})

debouncedHandler()
await sleep(450)
debouncedHandler()
await sleep(450)
debouncedHandler()
await sleep(450)
debouncedHandler()
await sleep(450)
debouncedHandler()
await sleep(250)
debouncedHandler()

await sleep(2000)

debouncedHandler()
debouncedHandler()
