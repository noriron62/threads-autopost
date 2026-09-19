import { google } from "googleapis";

// ============================================
// 型定義
// ============================================

export type PostStatus = "未投稿" | "投稿済み" | "エラー";

export interface PostRow {
  rowNumber: number; // シート上の行番号(更新時に使用。1行目はヘッダーなので実データは2から)
  status: PostStatus | "";
  scheduledAt: Date | null;
  text1: string; // 1/2本文
  photoUrls: string[]; // 写真URL1〜4のうち、空欄でないものだけを配列化(2〜4枚)
  topicTag: string; // トピックタグ(空欄なら"")
  text2: string; // 2/2本文
  photoUrl2: string; // 2/2写真URL(1枚)
  firstPostId: string; // 1/2投稿ID(記録用、通常は空欄から始まる)
  errorNote: string; // エラーメモ
}

// シートの列順序(A〜L)と対応させる定数
// 列がずれた場合はここだけ直せばよい
const COLUMNS = {
  status: 0, // A
  scheduledAt: 1, // B
  text1: 2, // C
  photo1: 3, // D
  photo2: 4, // E
  photo3: 5, // F
  photo4: 6, // G
  topicTag: 7, // H
  text2: 8, // I
  photoUrl2: 9, // J
  firstPostId: 10, // K
  errorNote: 11, // L
} as const;

const SHEET_NAME = "Threads投稿管理"; // シートのタブ名。実際の名前に合わせて変更してください
const HEADER_ROW_COUNT = 1; // 見出し行の数(1行目がヘッダー)

// ============================================
// 認証
// ============================================

function getAuth() {
  // サービスアカウントのJSONキーは環境変数(GitHub Secrets)にJSON文字列として保存し、
  // ここでパースして使う想定。ファイルパスで持ちたい場合はkeyFileオプションに差し替え可。
  const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credentialsJson) {
    throw new Error("環境変数 GOOGLE_SERVICE_ACCOUNT_JSON が設定されていません");
  }

  const credentials = JSON.parse(credentialsJson);

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

// ============================================
// 読み込み
// ============================================

/**
 * シート内の全データ行を読み込み、PostRow[]に変換して返す。
 * 空行(A列が空欄)はスキップする。
 */
export async function readAllRows(spreadsheetId: string): Promise<PostRow[]> {
  const sheets = getSheetsClient();

  const range = `${SHEET_NAME}!A${HEADER_ROW_COUNT + 1}:L`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const values = res.data.values ?? [];
  const rows: PostRow[] = [];

  values.forEach((row, index) => {
    // 完全な空行はスキップ
    if (row.length === 0 || !row[COLUMNS.status]) {
      // ステータス列すら空なら、まだ何もデータが入っていない行とみなしてスキップ
      // (ただしB列以降にデータがあるのにA列だけ空、という不整合は起きない前提)
      if (row.every((cell) => !cell)) return;
    }

    const photoUrls = [
      row[COLUMNS.photo1],
      row[COLUMNS.photo2],
      row[COLUMNS.photo3],
      row[COLUMNS.photo4],
    ].filter((url): url is string => !!url && url.trim() !== "");

    rows.push({
      rowNumber: HEADER_ROW_COUNT + index + 1,
      status: (row[COLUMNS.status] as PostStatus) || "",
      scheduledAt: parseDateCell(row[COLUMNS.scheduledAt]),
      text1: row[COLUMNS.text1] ?? "",
      photoUrls,
      topicTag: row[COLUMNS.topicTag] ?? "",
      text2: row[COLUMNS.text2] ?? "",
      photoUrl2: row[COLUMNS.photoUrl2] ?? "",
      firstPostId: row[COLUMNS.firstPostId] ?? "",
      errorNote: row[COLUMNS.errorNote] ?? "",
    });
  });

  return rows;
}

/**
 * 「未投稿」かつ「投稿予定日時が現在時刻以前」の行だけを抽出する。
 */
export async function findDueRows(spreadsheetId: string): Promise<PostRow[]> {
  const allRows = await readAllRows(spreadsheetId);
  const now = new Date();

  return allRows.filter((row) => {
    if (row.status !== "未投稿") return false;
    if (!row.scheduledAt) return false;
    return row.scheduledAt.getTime() <= now.getTime();
  });
}

function parseDateCell(value: string | undefined): Date | null {
  if (!value) return null;

  // "2026-09-19 19:00" でも "2026/09/19 23:52:00" でも読み取れるようにする
  const match = value
    .trim()
    .match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);

  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;

  // 日本時間として解釈し、UTCに変換して比較できるDateを作る
  const utcMillis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - 9, // JST → UTC
    Number(minute),
    Number(second ?? "0")
  );

  return new Date(utcMillis);
}

// ============================================
// 書き込み(更新)
// ============================================

/**
 * 投稿成功時:ステータスを「投稿済み」にし、1/2投稿IDを記録する。
 */
export async function markAsPosted(
  spreadsheetId: string,
  rowNumber: number,
  firstPostId: string
): Promise<void> {
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `${SHEET_NAME}!A${rowNumber}`,
          values: [["投稿済み"]],
        },
        {
          range: `${SHEET_NAME}!K${rowNumber}`,
          values: [[firstPostId]],
        },
      ],
    },
  });
}

/**
 * 投稿失敗時:ステータスを「エラー」にし、エラー内容をL列に記録する。
 */
export async function markAsError(
  spreadsheetId: string,
  rowNumber: number,
  errorMessage: string
): Promise<void> {
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [
        {
          range: `${SHEET_NAME}!A${rowNumber}`,
          values: [["エラー"]],
        },
        {
          range: `${SHEET_NAME}!L${rowNumber}`,
          // 長くなりすぎないよう300文字程度に丸めておく
          values: [[errorMessage.slice(0, 300)]],
        },
      ],
    },
  });
}
