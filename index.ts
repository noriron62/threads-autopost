import { findDueRows, markAsPosted, markAsError } from "./sheets";
import { postFullThread } from "./threads";

async function main() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error("環境変数 SPREADSHEET_ID が設定されていません");
  }

  const dueRows = await findDueRows(spreadsheetId);

  if (dueRows.length === 0) {
    console.log("投稿予定の行はありません。終了します。");
    return;
  }

  console.log(`${dueRows.length}件の投稿予定を処理します。`);

  for (const row of dueRows) {
    console.log(`--- 行${row.rowNumber} の処理を開始 ---`);

    try {
      // 入力チェック(最低限のバリデーション)
      // 1/2の写真は任意: 0枚なら文字のみ、1枚なら単一画像、2〜4枚ならカルーセルになる
      if (!row.text1) throw new Error("1/2本文が空です");
      if (!row.text2) throw new Error("2/2本文が空です");
      // 2/2の写真は任意: 空欄なら文字だけの投稿になる

      const result = await postFullThread({
        text1: row.text1,
        photoUrls: row.photoUrls,
        topicTag: row.topicTag,
        text2: row.text2,
        photoUrl2: row.photoUrl2,
      });

      await markAsPosted(spreadsheetId, row.rowNumber, result.firstPostId);
      console.log(`行${row.rowNumber}: 投稿成功(1/2投稿ID=${result.firstPostId})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`行${row.rowNumber}: 投稿失敗 - ${message}`);
      await markAsError(spreadsheetId, row.rowNumber, message);
      // 1件の失敗で全体を止めず、次の行の処理へ進む
    }
  }

  console.log("全ての処理が完了しました。");
}

main().catch((err) => {
  console.error("致命的なエラーで処理を中断しました:", err);
  process.exit(1);
});
