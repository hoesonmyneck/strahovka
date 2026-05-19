# Государственная компания по страхованию жизни

Веб-приложение для управления данными страховых договоров с поддержкой 500k+ записей, фильтрации, поиска и экспорта.

## Архитектура

- **Backend**: FastAPI + SQLAlchemy + PostgreSQL
- **Frontend**: React + AG Grid + Axios
- **Авторизация**: JWT токены (admin/user)
- **Контейнеризация**: Docker + Docker Compose

## Функции

- Пагинация (100 записей на страницу) для больших объемов данных
- Фильтры по всем полям (БИН, название, даты, область, статус)
- Поиск по БИН и названию компании
- Фильтр "Истекает через 1/3/6 месяцев"
- Метрики: всего / застраховано / не застраховано
- Скачивание в Excel с примененными фильтрами
- Загрузка новых данных (только admin)

## Учетные записи

| Логин | Пароль | Роль |
|-------|--------|------|
| admin | admin123 | Admin - может загружать файлы |
| user | user123 | User - только просмотр и скачивание |

## Запуск

### 1. Требования

- Docker
- Docker Compose

### 2. Запуск

```bash
# Клонируйте/перейдите в директорию проекта
cd strahovka

# Запустите все сервисы
docker-compose up --build

# Или в фоновом режиме
docker-compose up -d --build
```

### 3. Импорт начальных данных

После первого запуска нужно импортировать данные из Excel:

```bash
# Копируем Excel файл в контейнер
docker cp GAK.xlsx strahovka-backend:/app/

# Запускаем импорт
docker exec strahovka-backend python import_excel.py GAK.xlsx
```

Или используйте UI: зайдите как admin и загрузите файл через интерфейс.

### 4. Доступ

- Приложение: http://localhost
- API: http://localhost:8000
- Документация API: http://localhost:8000/docs

## Разработка

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Frontend

```bash
cd frontend
npm install --legacy-peer-deps
npm start
```

## API Endpoints

- `POST /api/auth/login` - Вход
- `GET /api/auth/me` - Информация о пользователе
- `GET /api/metrics` - Метрики (всего/застраховано/не застраховано)
- `GET /api/records` - Список записей с пагинацией
- `GET /api/records/download` - Скачать в Excel
- `POST /api/upload` - Загрузить Excel (admin only)

## Фильтры

Все фильтры передаются как query параметры:

- `bin` - Поиск по БИН
- `bin_name` - Поиск по названию
- `contract_date_from/to` - Диапазон дат договора
- `date_end_from/to` - Диапазон дат окончания
- `expires_in_months` - 1, 3 или 6
- `is_insured` - 1 или 0
- `obl_name`, `rai_name`, `opf_name` - По областям и ОПФ

Пример:
```
/api/records?bin=123&expires_in_months=3&page=1
```

## Структура проекта

```
strahovka/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py          # API endpoints
│   │   ├── models.py        # SQLAlchemy модели
│   │   ├── schemas.py       # Pydantic схемы
│   │   ├── database.py      # Подключение к БД
│   │   └── auth.py          # Аутентификация
│   ├── Dockerfile
│   ├── requirements.txt
│   └── import_excel.py      # Скрипт импорта
├── frontend/
│   ├── src/
│   │   ├── components/      # React компоненты
│   │   ├── context/         # Auth контекст
│   │   ├── utils/           # API утилиты
│   │   ├── App.js
│   │   ├── styles.css
│   │   └── index.js
│   ├── public/
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml
└── README.md
```

## Деплой на Linux сервер

```bash
# На сервере
git clone <repo>
cd strahovka

# Копируем Excel файл
cp /path/to/GAK.xlsx ./

# Запуск
docker-compose up -d --build

# Импорт данных
docker cp GAK.xlsx strahovka-backend:/app/
docker exec strahovka-backend python import_excel.py GAK.xlsx

# Проверка логов
docker-compose logs -f
```
