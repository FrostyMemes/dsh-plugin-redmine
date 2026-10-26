# Карта endpoints Redmine

Источник: список endpoints корпоративного инстанса, предоставленный пользователем 26.10.2026. Это сведения о доступных маршрутах, а не результат подключения плагина к серверу. Имена файлов `redmine/*.ts` в исходном списке относятся к внешней интеграции, а не к структуре этого плагина.

Последующее уточнение пользователя: сервер относится к **Redmine 4.1.x**, точный patch неизвестен. [Исходник `4.1-stable`](https://github.com/redmine/redmine/blob/4.1-stable/app/helpers/projects_helper.rb) подтверждает вложенные массивы `trackers` и `issue_categories`, используемые плагином. [Changelog 4.1](https://www.redmine.org/projects/redmine/wiki/Changelog_4_1) относит смену footer на 2022 к 4.1.6; поэтому 4.1.6/4.1.7 согласуются с наблюдением, но точный patch так не доказан (возможны локальные изменения темы/сборки).

## Панель MVP

| GET endpoint | Использование |
| --- | --- |
| `/users/current.json` | Идентичность пользователя и проверка авторизации. |
| `/issues.json?{query}` | Метаданные задач, фильтрация и постраничная выборка. Описание, комментарии и история в DTO панели не попадают. |
| `/projects.json?{query}` | Все доступные страницы проектов. |
| `/issue_statuses.json` | Справочник статусов. |
| `/enumerations/issue_priorities.json` | Справочник приоритетов. |
| `/projects/{id}.json?include=trackers,issue_categories` | Категории проекта и типы задач. Данные читаются из `project.issue_categories` и `project.trackers`. |

`/trackers.json` не подтверждён предоставленным списком и не вызывается: типы задач собираются из деталей всех доступных проектов, с предупреждениями при частичной доступности. Категории включаются в каталог только для выбранных проектов или проектов загруженных задач. Вместо отдельного `/projects/{id}/issue_categories.json` используется известный для инстанса путь через детали проекта. В исходном списке 404 указан для `/issue_categories.json`: это не доказательство отсутствия стандартного проектного маршрута `/projects/{id}/issue_categories.json`.

## Сверка с официальным API — 26.10.2026

- Подвал `© 2006–2022` не определяет точный релиз. В 2022 году выходили 4.1.x, 4.2.x и 5.0.x: [официальный анонс](https://www.redmine.org/news/135). Выбор версии по этой строке остаётся предположением.
- [Projects API](https://www.redmine.org/projects/redmine/wiki/Rest_Projects) документирует `include=trackers,issue_categories` для деталей проекта. Это соответствует выбранному пути.
- [Trackers API](https://www.redmine.org/projects/redmine/wiki/Rest_Trackers) и [Categories API](https://www.redmine.org/projects/redmine/wiki/Rest_IssueCategories) также документируют общий `/trackers.json` и проектный `/projects/{id}/issue_categories.json`. Их отсутствие нельзя выводить только из возраста установки или отсутствия в предоставленном списке. Плагин использует путь через детали проекта, не объявляя эти стандартные маршруты несуществующими.
- [Issues API](https://www.redmine.org/projects/redmine/wiki/Rest_Issues) описывает `assigned_to_id=me`, `status_id=*`, группы `open/closed`, `offset/limit`. Эти параметры соответствуют контролируемой выборке панели. Новые поля вроде `allowed_statuses` (с 5.0.x) не требуются.
- [Общие правила REST](https://www.redmine.org/projects/redmine/wiki/Rest_api) подтверждают заголовок `X-Redmine-API-Key`, включение REST API администратором, максимум 100 элементов на страницу и необходимость обхода страниц. Эти правила уже соблюдаются транспортом.

Документация обновляется вместе с Redmine и содержит новые возможности; она не подтверждает версию, права и доступность конкретного корпоративного сервера. Необычные маршруты из предоставленного списка, включая документы и DMSF, не считаются стандартными возможностями старого ядра без отдельной проверки.

## Известны, но не нужны панели MVP

| GET endpoint | Назначение внешней интеграции |
| --- | --- |
| `/issues/{id}.json?include=...` | Полная задача, journals, attachments, children, relations, watchers. Панель не загружает эти данные. |
| `/projects/{id}.json?include=trackers,issue_categories,enabled_modules` | Расширенные детали проекта; `enabled_modules` панели не требуется. |
| `/projects/{id}/memberships.json?{query}` | Участники. |
| `/projects/{id}/versions.json`, `/versions/{id}.json` | Версии. |
| `/queries.json?{query}` | Публичные сохранённые фильтры. |
| `/projects/{project}/wiki/index.json` | Страницы wiki. |
| `/projects/{project}/wiki/{page}.json`, `/projects/{project}/wiki/{page}/{version}.json` | Текст и версии wiki. |
| `/attachments/{id}.json`, `/attachments/download/{id}/{filename}` | Метаданные и содержимое вложений. |
| `/documents.json?{query}`, `/projects/{id}/documents.json?{query}`, `/documents/{id}.json` | Документы. |
| `/projects/{id}/dmsf.json`, `/dmsf/folders/{id}.json`, `/dmsf/files/{id}.json`, `/dmsf/files/{id}/view` | Плагин DMSF. |
| `/time_entries.json?{query}` | Учёт времени, диапазон `from/to`. |
| `/search.json?{params}` | Полнотекстовый поиск `q`. Наличие не подтверждает совместимость с фильтрами списка; поиск панели остаётся по выбранным метаданным на Host. |

## Пишущие маршруты внешней интеграции

`POST /issues.json`, `PUT /issues/{id}.json` и `PUT /projects/{project}/wiki/{page}.json` известны из предоставленного списка, но плагин их не реализует и не вызывает. Права существующих у пользователя MCP определяются отдельно от read-only транспорта панели.
