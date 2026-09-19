// ============================================
// Threads API 連携
// ============================================
// 参考: https://developers.facebook.com/docs/threads/posts/
//
// 投稿の流れ(1/2がカルーセル、2/2が返信)は3〜4段階のAPI呼び出しに分かれる:
//   1. 画像ごとに「カルーセル用の子コンテナ」を作成(is_carousel_item=true)
//   2. 子コンテナのIDをまとめて「カルーセル本体のコンテナ」を作成
//   3. カルーセル本体のコンテナを公開 → 1/2投稿のIDが返る
//   4. 2/2の投稿を、reply_to_idに1/2の投稿IDを指定して作成・公開

const GRAPH_API_BASE = "https://graph.threads.net/v1.0";

function getConfig() {
  const accessToken = process.env.THREADS_ACCESS_TOKEN;
  const userId = process.env.THREADS_USER_ID;

  if (!accessToken) throw new Error("環境変数 THREADS_ACCESS_TOKEN が設定されていません");
  if (!userId) throw new Error("環境変数 THREADS_USER_ID が設定されていません");

  return { accessToken, userId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================
// 共通のAPI呼び出しヘルパー
// ============================================

async function callThreadsApi(
  path: string,
  params: Record<string, string>
): Promise<any> {
  const { accessToken } = getConfig();

  const url = new URL(`${GRAPH_API_BASE}${path}`);
  const body = new URLSearchParams({ ...params, access_token: accessToken });

  const res = await fetch(url.toString(), {
    method: "POST",
    body,
  });

  const data = await res.json();

  if (!res.ok) {
    // Threads APIのエラーは data.error.message に理由が入っていることが多い
    const message = data?.error?.message ?? JSON.stringify(data);
    throw new Error(`Threads API エラー(${path}): ${message}`);
  }

  return data;
}

// ============================================
// ステップ1: 画像1枚ごとのコンテナ作成(カルーセルの部品)
// ============================================

async function createCarouselItemContainer(imageUrl: string): Promise<string> {
  const { userId } = getConfig();

  const data = await callThreadsApi(`/${userId}/threads`, {
    media_type: "IMAGE",
    image_url: imageUrl,
    is_carousel_item: "true",
  });

  return data.id as string; // creation_id
}

// ============================================
// ステップ2〜3: カルーセル本体の作成→公開(1/2投稿)
// ============================================

interface FirstPostInput {
  text: string; // 1/2本文
  imageUrls: string[]; // 2〜4枚
  topicTag?: string; // 空欄なら未指定
}

/**
 * カルーセル投稿(1/2)を作成・公開し、公開後の投稿IDを返す。
 */
export async function postFirstThread(input: FirstPostInput): Promise<string> {
  const { userId } = getConfig();

  if (input.imageUrls.length < 2 || input.imageUrls.length > 4) {
    throw new Error(
      `1/2投稿の画像枚数が想定外です(2〜4枚のはずが${input.imageUrls.length}枚)`
    );
  }

  // 1. 画像ごとに子コンテナを作成
  const childrenIds: string[] = [];
  for (const url of input.imageUrls) {
    const id = await createCarouselItemContainer(url);
    childrenIds.push(id);
  }

  // 2. カルーセル本体のコンテナを作成
  const carouselParams: Record<string, string> = {
    media_type: "CAROUSEL",
    children: childrenIds.join(","),
    text: input.text,
  };

  // トピックタグ: 公式ドキュメントに明記されたパラメータではないため、
  // 送っても無視される可能性がある(実地でのテスト投稿で要確認)。
  // 空欄でなければ試験的に付与する。
  if (input.topicTag) {
    carouselParams.topic_tag = input.topicTag;
  }

  const carouselContainer = await callThreadsApi(`/${userId}/threads`, carouselParams);
  const creationId = carouselContainer.id as string;

  // 3. 公開前に、コンテナの処理が完了するまで少し待つ
  //   (Threads API推奨: 平均30秒。念のため状態確認もはさむ)
  await waitUntilContainerReady(creationId);

  const publishResult = await callThreadsApi(`/${userId}/threads_publish`, {
    creation_id: creationId,
  });

  return publishResult.id as string; // 公開された1/2投稿のID
}

// ============================================
// ステップ4: 2/2を返信として作成・公開
// ============================================

interface SecondPostInput {
  text: string; // 2/2本文(アフィリエイトリンクを含む)
  imageUrl: string; // 1枚
  replyToId: string; // 1/2投稿のID
}

export async function postSecondThread(input: SecondPostInput): Promise<string> {
  const { userId } = getConfig();

  const container = await callThreadsApi(`/${userId}/threads`, {
    media_type: "IMAGE",
    image_url: input.imageUrl,
    text: input.text,
    reply_to_id: input.replyToId,
  });

  const creationId = container.id as string;

  await waitUntilContainerReady(creationId);

  const publishResult = await callThreadsApi(`/${userId}/threads_publish`, {
    creation_id: creationId,
  });

  return publishResult.id as string;
}

// ============================================
// コンテナの処理完了を待つ(公開前チェック)
// ============================================

async function waitUntilContainerReady(
  creationId: string,
  maxWaitMs = 60000,
  intervalMs = 5000
): Promise<void> {
  const { accessToken } = getConfig();
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const url = `${GRAPH_API_BASE}/${creationId}?fields=status,error_message&access_token=${accessToken}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status === "FINISHED") return;
    if (data.status === "ERROR") {
      throw new Error(`コンテナ処理が失敗しました: ${data.error_message ?? "詳細不明"}`);
    }
    // IN_PROGRESS や EXPIRED 以外の場合はそのまま待機を続ける
    await sleep(intervalMs);
  }

  // タイムアウトしても、Threads側の推奨(平均30秒待てば大抵OK)に従い
  // 一応公開を試みる(呼び出し元でエラーハンドリングされる)
}

// ============================================
// 1/2 → 2/2 をまとめて実行する高レベル関数
// ============================================

export interface ThreadPostPlan {
  text1: string;
  photoUrls: string[];
  topicTag: string; // "" なら未指定
  text2: string;
  photoUrl2: string;
}

export interface ThreadPostResult {
  firstPostId: string;
  secondPostId: string;
}

export async function postFullThread(plan: ThreadPostPlan): Promise<ThreadPostResult> {
  const firstPostId = await postFirstThread({
    text: plan.text1,
    imageUrls: plan.photoUrls,
    topicTag: plan.topicTag || undefined,
  });

  // 連投時のレート制限・処理待ちのクッションとして少し空ける
  await sleep(5000);

  const secondPostId = await postSecondThread({
    text: plan.text2,
    imageUrl: plan.photoUrl2,
    replyToId: firstPostId,
  });

  return { firstPostId, secondPostId };
}
