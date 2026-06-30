import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

loadDotEnv();

const config = {
  larkCli: process.env.LARK_CLI || "lark-cli",
  larkIdentity: process.env.LARK_IDENTITY || "user",
  baseToken: process.env.LARK_BASE_TOKEN || "P8HZbDIw4aOidbs3iL4cj3skndc",
  tableId: process.env.LARK_TABLE_ID || "tblujFmRD6W9if1e",
  viewId: process.env.LARK_VIEW_ID || "vewGywBr8d",
  baseUrl:
    process.env.BASE_URL ||
    "https://zhuanspirit.feishu.cn/base/P8HZbDIw4aOidbs3iL4cj3skndc?table=tblujFmRD6W9if1e&view=vewGywBr8d#CategoryScheduledTask",
  webhookUrl: process.env.LARK_WEBHOOK_URL,
  webhookSecret: process.env.LARK_WEBHOOK_SECRET,
  activeStatuses: (process.env.ACTIVE_STATUSES || "待办,进行中")
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean),
  includeUnassigned: process.env.INCLUDE_UNASSIGNED !== "0",
  dryRun: process.env.DRY_RUN === "1"
};

const fields = ["待办事项", "待办负责人", "周会日期", "状态", "备注"];

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  const records = await loadRecords();
  const activeRecords = records.filter(isActiveRecord);
  const text = buildMessage(activeRecords);

  if (config.dryRun) {
    console.log(text);
    return;
  }

  if (!config.webhookUrl) {
    throw new Error("Missing LARK_WEBHOOK_URL. Set it in the environment before sending.");
  }

  await sendWebhook(text);
  console.log(`Sent ${activeRecords.length} active task(s) to the Feishu group bot.`);
}

async function loadRecords() {
  const records = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const args = [
      "base",
      "+record-list",
      "--base-token",
      config.baseToken,
      "--table-id",
      config.tableId,
      "--view-id",
      config.viewId,
      "--limit",
      String(limit),
      "--offset",
      String(offset),
      "--format",
      "json",
      "--as",
      config.larkIdentity
    ];

    for (const field of fields) {
      args.push("--field-id", field);
    }

    const { stdout } = await execFileAsync(config.larkCli, args, {
      maxBuffer: 10 * 1024 * 1024
    });
    const response = JSON.parse(stdout);

    if (!response.ok) {
      throw new Error(`lark-cli returned an unsuccessful response: ${stdout}`);
    }

    const data = response.data || {};
    const pageRecords = (data.data || []).map((row, index) =>
      rowToRecord(row, data.record_id_list?.[index])
    );
    records.push(...pageRecords);

    if (!data.has_more || pageRecords.length === 0) {
      break;
    }

    offset += pageRecords.length;
  }

  return records;
}

function rowToRecord(row, recordId) {
  return {
    recordId,
    title: row[0] || "",
    owners: row[1] || [],
    meetingDate: row[2] || "",
    statuses: row[3] || [],
    note: row[4] || ""
  };
}

function isActiveRecord(record) {
  const hasActiveStatus = record.statuses.some((status) =>
    config.activeStatuses.includes(status)
  );
  const hasOwner = record.owners.length > 0;
  return hasActiveStatus && (hasOwner || config.includeUnassigned);
}

function buildMessage(records) {
  const today = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium"
  }).format(new Date());

  if (records.length === 0) {
    return [
      `周会待办提醒 ${today}`,
      "",
      "当前没有待提醒的待办事项。",
      "",
      `查看待办：${config.baseUrl}`
    ].join("\n");
  }

  const grouped = groupByOwner(records);
  const lines = [
    `周会待办提醒 ${today}`,
    `共 ${records.length} 个未完成事项，请相关负责人及时更新状态。`,
    ""
  ];

  for (const group of grouped) {
    lines.push(group.label);
    group.records.forEach((record, index) => {
      const meetingDate = record.meetingDate
        ? ` 周会日期：${formatDateForMessage(record.meetingDate)}`
        : "";
      const status = record.statuses.length ? ` 状态：${record.statuses.join("/")}` : "";
      lines.push(`${index + 1}. ${record.title}${status}${meetingDate}`);
      if (record.note) {
        lines.push(`   备注：${record.note}`);
      }
    });
    lines.push("");
  }

  lines.push(`查看待办：${config.baseUrl}`);
  return lines.join("\n").trim();
}

function groupByOwner(records) {
  const groups = new Map();

  for (const record of records) {
    if (record.owners.length === 0) {
      addToGroup(groups, "__unassigned__", "未分配负责人", record);
      continue;
    }

    for (const owner of record.owners) {
      addToGroup(groups, owner.id, renderMention(owner), record);
    }
  }

  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

function addToGroup(groups, key, label, record) {
  if (!groups.has(key)) {
    groups.set(key, { label, records: [] });
  }
  groups.get(key).records.push(record);
}

function renderMention(owner) {
  if (!owner?.id) {
    return owner?.name || "未知负责人";
  }
  return `<at user_id="${owner.id}">${owner.name || owner.id}</at>`;
}

function formatDateForMessage(value) {
  return String(value).replace(/\s+00:00:00$/, "");
}

async function sendWebhook(text) {
  const retryDelaysMs = [60_000, 120_000];

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const result = await trySendWebhook(text);
    if (result.ok) {
      return;
    }

    if (!result.retryable || attempt === retryDelaysMs.length) {
      throw new Error(result.message);
    }

    const delayMs = retryDelaysMs[attempt];
    console.error(`${result.message}. Retrying in ${delayMs / 1000}s.`);
    await sleep(delayMs);
  }
}

async function trySendWebhook(text) {
  const payload = {
    msg_type: "text",
    content: { text }
  };

  if (config.webhookSecret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    payload.timestamp = timestamp;
    payload.sign = createHmac("sha256", `${timestamp}\n${config.webhookSecret}`)
      .update("")
      .digest("base64");
  }

  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  });
  const body = await response.text();

  if (!response.ok) {
    return {
      ok: false,
      retryable: response.status === 429,
      message: `Webhook request failed with HTTP ${response.status}: ${body}`
    };
  }

  const result = JSON.parse(body);
  if (result.code !== 0) {
    return {
      ok: false,
      retryable: result.code === 11232,
      message: `Webhook returned code ${result.code}: ${body}`
    };
  }

  return { ok: true };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function loadDotEnv() {
  const envPath = new URL("../.env", import.meta.url);
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^(['"])(.*)\1$/, "$2");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
