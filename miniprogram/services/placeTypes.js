// 地点类型（spec 4.4）：云函数 PLACE_TYPES 对应的展示标签
const TYPE_OPTIONS = [
  { value: 'restaurant', label: '餐厅' },
  { value: 'attraction', label: '景点' },
  { value: 'accommodation', label: '住宿' },
  { value: 'other', label: '其他' }
]

const typeLabelOf = value =>
  (TYPE_OPTIONS.find(t => t.value === value) || {}).label || ''

module.exports = { TYPE_OPTIONS, typeLabelOf }
