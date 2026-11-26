// Product types as Intec groups them, and money as the office writes it
export const TYPE_NAMES = {
  '01': 'Hinges and pivots', '02': 'Door closers', '03': 'Locks and cylinders', '04': 'Door handles',
  '05': 'Signage', '06': 'Door protection', '07': 'Accessories', '': 'Other',
}
export const TYPE_ORDER = ['01', '02', '03', '04', '05', '06', '07', '']
export const money = v => (v == null ? '' : v.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

/* Group a set's items under Intec's type headings, in order. */
export function groupItems(items) {
  const by = {}
  for (const it of items) (by[it.product_type || ''] ||= []).push(it)
  return TYPE_ORDER.filter(t => by[t]).map(t => ({ type: t, name: TYPE_NAMES[t], items: by[t] }))
}
