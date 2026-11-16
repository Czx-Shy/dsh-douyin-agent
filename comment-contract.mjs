// 评论读取、模型选择和发布器共用的稳定契约。
export const COMMENT_LIST_LIMIT = 20;
export const COMMENT_TEXT_LIMIT = 300;
export const COMMENT_ID_PATTERN = /^\d{1,64}$/;

export const validCommentId = value => typeof value === 'string' && COMMENT_ID_PATTERN.test(value);
