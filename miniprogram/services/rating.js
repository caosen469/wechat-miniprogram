// 评分的展示规则：星级 → 情绪档位（spec 3：由评分映射，不单独录入）与星串
const gradeOf = rating =>
  rating >= 4 ? '宝藏' : rating === 3 ? '还行' : rating > 0 ? '踩雷' : ''

// 档位的配色 key（宝藏 good / 还行 mid / 踩雷 bad），徽章与统计条共用，
// 与云函数 listPlaces 的 tierOfRating 保持同一阈值
const tierKeyOf = rating =>
  rating >= 4 ? 'good' : rating === 3 ? 'mid' : 'bad'

const starsOf = rating =>
  '★'.repeat(rating) + '☆'.repeat(5 - rating)

module.exports = { gradeOf, tierKeyOf, starsOf }
