// 评分的展示规则：星级 → 情绪档位（spec 3：由评分映射，不单独录入）与星串
const gradeOf = rating =>
  rating >= 4 ? '宝藏' : rating === 3 ? '还行' : rating > 0 ? '踩雷' : ''

const starsOf = rating =>
  '★'.repeat(rating) + '☆'.repeat(5 - rating)

module.exports = { gradeOf, starsOf }
