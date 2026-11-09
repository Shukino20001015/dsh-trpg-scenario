// Narrow, deterministic guard against introducing a kinship identity absent
// from the cited host messages. This cannot prove who said or did any act.
const groups=[
 ['母亲','妈妈','我妈','你妈','她妈','他妈'],
 ['父亲','爸爸','我爸','你爸','她爸','他爸'],
]
export function hasUnsupportedKinship(before,after,quotes){
 if(typeof before!=='string'||typeof after!=='string'||!Array.isArray(quotes)||quotes.some(q=>typeof q!=='string'))return true
 const visible=quotes.join('\n')
 return groups.some(aliases=>aliases.some(term=>after.includes(term))&&!aliases.some(term=>before.includes(term))&&!aliases.some(term=>visible.includes(term)))
}
