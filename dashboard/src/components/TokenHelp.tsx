/**
 * Inline "Помощь" expandable affordance for token / API-key inputs.
 *
 * One component per kind so the content can be highly tailored — required
 * scopes, where exactly to click in the provider's UI, gotchas. Uses a
 * native `<details>` element so it's keyboard-accessible without extra
 * wiring and stays closed by default (no layout shift until clicked).
 *
 * Links open in a new tab and never expose the token itself — they point
 * at the provider's token-creation pages, not at any user data.
 */

export type TokenHelpKind = "git-pat" | "claude-api" | "openai-api" | "telegram-bot";

interface Props {
  kind: TokenHelpKind;
}

export function TokenHelp({ kind }: Props) {
  return (
    <details className="group inline-block">
      <summary className="cursor-pointer text-[11px] text-accent-blue hover:underline list-none inline-flex items-center gap-1 select-none">
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-accent-blue/40 text-[10px] font-semibold leading-none">
          ?
        </span>
        Помощь — как получить
      </summary>
      <div className="mt-2 p-3 bg-bg-elevated border border-border text-xs leading-relaxed flex flex-col gap-3 max-w-[640px]">
        {kind === "git-pat" && <GitPatHelp />}
        {kind === "claude-api" && <ClaudeApiHelp />}
        {kind === "openai-api" && <OpenAiApiHelp />}
        {kind === "telegram-bot" && <TelegramBotHelp />}
      </div>
    </details>
  );
}

function GitPatHelp() {
  return (
    <>
      <p className="text-text-secondary">
        Personal Access Token нужен для клона, push'ей веток и открытия PR. Без него orchestra не
        сможет работать с приватным репозиторием.
      </p>

      <section className="flex flex-col gap-1">
        <h4 className="font-semibold text-text-primary">GitHub (fine-grained PAT — рекомендуется)</h4>
        <ol className="list-decimal pl-4 flex flex-col gap-0.5 text-text-secondary">
          <li>
            Откройте{" "}
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-blue hover:underline"
            >
              github.com/settings/personal-access-tokens/new
            </a>
          </li>
          <li>
            <strong>Repository access</strong> → выбрать конкретный репозиторий (или Only select repositories)
          </li>
          <li>
            <strong>Permissions → Repository permissions:</strong>
            <ul className="list-disc pl-4 mt-1 text-text-tertiary">
              <li>Contents — Read and write</li>
              <li>Pull requests — Read and write</li>
              <li>Metadata — Read-only (включается автоматически)</li>
              <li>Workflows — Read and write (если PR трогают <code>.github/workflows/</code>)</li>
            </ul>
          </li>
          <li>Expiration: ≤90 дней рекомендуется (rotate потом руками)</li>
          <li>Generate token → скопируйте сразу (показывается один раз)</li>
        </ol>
      </section>

      <section className="flex flex-col gap-1">
        <h4 className="font-semibold text-text-primary">GitLab</h4>
        <ol className="list-decimal pl-4 flex flex-col gap-0.5 text-text-secondary">
          <li>
            <strong>Project access token (рекомендуется):</strong> Settings → Access Tokens в самом
            репозитории. Role: Developer (или Maintainer для merge). Scopes: <code>api</code>,{" "}
            <code>write_repository</code>.
          </li>
          <li>
            <strong>Personal access token:</strong>{" "}
            <a
              href="https://gitlab.com/-/user_settings/personal_access_tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-blue hover:underline"
            >
              gitlab.com/-/user_settings/personal_access_tokens
            </a>
            . Scopes: <code>api</code>, <code>write_repository</code>, <code>read_repository</code>.
          </li>
        </ol>
      </section>

      <p className="text-text-tertiary text-[11px]">
        Токен хранится в БД зашифрованным (AES-256-GCM) и виден только владельцу проекта.
      </p>
    </>
  );
}

function ClaudeApiHelp() {
  return (
    <>
      <p className="text-text-secondary">
        Anthropic API ключ нужен для режима <strong>API</strong>. Биллинг по токенам — оплата идёт за
        каждый вызов. Если у вас подписка Claude Max / Pro, выберите режим{" "}
        <strong>Подписка Max</strong> вместо API — он бесплатен в рамках подписки.
      </p>

      <ol className="list-decimal pl-4 flex flex-col gap-0.5 text-text-secondary">
        <li>
          Войдите в{" "}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-blue hover:underline"
          >
            console.anthropic.com → API keys
          </a>
        </li>
        <li>Нужна организация с активным биллингом (Settings → Billing → пополнить кредитами)</li>
        <li><strong>Create Key</strong> → название (любое) → Create</li>
        <li>
          Скопируйте ключ (начинается с <code>sk-ant-</code>) — показывается один раз
        </li>
      </ol>

      <p className="text-text-tertiary text-[11px]">
        Ключ хранится в БД зашифрованным. Без него API-режим работать не будет — orchestra покажет
        предупреждение при попытке запустить агента.
      </p>
    </>
  );
}

function OpenAiApiHelp() {
  return (
    <>
      <p className="text-text-secondary">
        OpenAI API ключ нужен для Codex в режиме <strong>API-ключ</strong>. Биллинг — через
        platform.openai.com, отдельно от подписки ChatGPT Plus / Pro. Если у вас подписка ChatGPT,
        выберите режим <strong>Подписка ChatGPT</strong> вместо API — она покрывает Codex без
        отдельной оплаты.
      </p>

      <ol className="list-decimal pl-4 flex flex-col gap-0.5 text-text-secondary">
        <li>
          Войдите в{" "}
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-blue hover:underline"
          >
            platform.openai.com → API keys
          </a>
        </li>
        <li>Нужен биллинг (Settings → Billing → добавить карту)</li>
        <li>
          <strong>Create new secret key</strong> → название (любое) → Permissions: <em>All</em> →
          Create
        </li>
        <li>
          Скопируйте ключ (начинается с <code>sk-proj-</code> или <code>sk-</code>) — показывается
          один раз
        </li>
      </ol>

      <p className="text-text-tertiary text-[11px]">
        Codex CLI игнорирует переменную <code>OPENAI_API_KEY</code>, поэтому orchestra при сохранении
        ключа дополнительно вызывает <code>codex login --with-api-key</code> чтобы прописать ключ в
        per-project auth.json. Сам ключ в БД хранится зашифрованным.
      </p>
    </>
  );
}

function TelegramBotHelp() {
  return (
    <>
      <p className="text-text-secondary">
        Telegram бот доставляет уведомления о PR, эскалациях и завершении задач. Для каждого проекта
        нужен <strong>отдельный бот</strong> — один бот нельзя использовать в нескольких проектах
        (Telegram long-polling — один listener на токен).
      </p>

      <ol className="list-decimal pl-4 flex flex-col gap-0.5 text-text-secondary">
        <li>
          Откройте в Telegram{" "}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-blue hover:underline"
          >
            @BotFather
          </a>
        </li>
        <li>
          Команда <code>/newbot</code>
        </li>
        <li>Display name → любое (можно русское)</li>
        <li>
          Username → обязательно заканчивается на <code>bot</code> (например{" "}
          <code>my_orchestra_bot</code>)
        </li>
        <li>
          BotFather вернёт токен формата <code>1234567890:AAH...</code> — вставьте сюда
        </li>
        <li>После сохранения откройте бота в Telegram и отправьте <code>/start</code> — orchestra
        привяжет chat ID автоматически
        </li>
      </ol>

      <p className="text-text-tertiary text-[11px]">
        Один бот нельзя шарить между проектами: при попытке сохранить уже занятый токен сервер вернёт
        409.
      </p>
    </>
  );
}
