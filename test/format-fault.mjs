const error = Date.UTC(2099, 0, 1, 9);
const notAnError = Date.UTC(2099, 0, 2, 9);
const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
Intl.DateTimeFormat.prototype.formatToParts = function (date) {
  if (Number(date) === error) throw new Error('a fault this test put in formatToParts');
  if (Number(date) === notAnError) throw undefined;
  return formatToParts.call(this, date);
};
