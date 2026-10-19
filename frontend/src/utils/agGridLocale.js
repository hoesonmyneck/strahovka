// Русская локализация AG Grid (фильтры, панели, статусбар). Передаётся в
// AgGridReact через проп localeText. Покрывает Community-функции (текстовый,
// числовой и дата-фильтры, меню, пагинация, «нет данных» и т.п.).
export const AG_GRID_LOCALE_RU = {
  // ── Текстовый фильтр ──
  contains: 'Содержит',
  notContains: 'Не содержит',
  equals: 'Равно',
  notEqual: 'Не равно',
  startsWith: 'Начинается с',
  endsWith: 'Заканчивается на',
  blank: 'Пусто',
  notBlank: 'Не пусто',

  // ── Числовой фильтр ──
  lessThan: 'Меньше',
  greaterThan: 'Больше',
  lessThanOrEqual: 'Меньше или равно',
  greaterThanOrEqual: 'Больше или равно',
  inRange: 'В диапазоне',
  inRangeStart: 'от',
  inRangeEnd: 'до',

  // ── Дата-фильтр ──
  dateFormatOoo: 'dd.mm.yyyy',
  before: 'До',
  after: 'После',

  // ── Общие элементы фильтра ──
  filterOoo: 'Фильтр…',
  searchOoo: 'Поиск…',
  applyFilter: 'Применить',
  resetFilter: 'Сбросить',
  clearFilter: 'Очистить',
  cancelFilter: 'Отмена',
  andCondition: 'И',
  orCondition: 'ИЛИ',
  noMatches: 'Нет совпадений',

  // ── Меню колонок ──
  columns: 'Колонки',
  filters: 'Фильтры',
  pinColumn: 'Закрепить колонку',
  pinLeft: 'Закрепить слева',
  pinRight: 'Закрепить справа',
  noPin: 'Не закреплять',
  autosizeThisColumn: 'Авторазмер колонки',
  autosizeAllColumns: 'Авторазмер всех колонок',
  resetColumns: 'Сбросить колонки',

  // ── Сортировка ──
  sortAscending: 'По возрастанию',
  sortDescending: 'По убыванию',
  sortUnSort: 'Без сортировки',

  // ── Прочее ──
  loadingOoo: 'Загрузка…',
  noRowsToShow: 'Нет данных',
  page: 'Страница',
  to: '–',
  of: 'из',
  nextPage: 'Следующая страница',
  previousPage: 'Предыдущая страница',
  firstPage: 'Первая страница',
  lastPage: 'Последняя страница',
}
