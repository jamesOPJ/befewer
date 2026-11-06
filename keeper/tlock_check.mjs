// Seal "A:<salt>" to a drand quicknet round ~9 s ahead, show it cannot be opened yet, then open it.
import tlock from 'tlock-js'
const { timelockEncrypt, timelockDecrypt, roundAt, mainnetClient } = tlock
const client = mainnetClient()  // quicknet: 3 s rounds, unchained BLS (required by tlock)
const info = await client.chain().info()
const target = roundAt(Date.now() + 9000, info)
const ct = await timelockEncrypt(target, Buffer.from('A:q7Xk2mP9vL4tR8wZ'), client)
console.log('target round', target, 'ciphertext bytes', ct.length)
try { await timelockDecrypt(ct, client); console.log('UNEXPECTED: opened early') } catch (e) { console.log('early open refused:', String(e.message || e).slice(0, 90)) }
await new Promise(r => setTimeout(r, 12000))
const pt = await timelockDecrypt(ct, client)
console.log('opened after the round:', pt.toString())
