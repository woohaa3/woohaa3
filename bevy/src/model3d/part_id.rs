//! 片场组合部件 id 的解码（与 contracts `encodeFilmSetPartId` 同构）。
//!
//! 身份编码为 `"<itemId 长度>:<itemId><partId>"`，因此从任意部件 id 都能还原所属对象；
//! 对象根是 `partId` 为空的同 itemId 编码。透明度动作需要它把「对象根 opacity」施加到该对象
//! 名下的全部块上（change: 2026-10-19-extend-film-set-for-motion-graphics，D2）。

/// 编码的对象/部件身份。
#[cfg(test)]
pub(crate) fn encode_part_id(item_id: &str, part_id: &str) -> String {
    format!("{}:{}{}", item_id.len(), item_id, part_id)
}

/// 解码后的身份。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DecodedPartId<'a> {
    pub item_id: &'a str,
    pub part_id: &'a str,
}

/// 解码 `encode_part_id` 的输出；非法返回 `None`（不猜测）。
pub(crate) fn decode_part_id(value: &str) -> Option<DecodedPartId<'_>> {
    let separator = value.find(':')?;
    let length: usize = value[..separator].parse().ok()?;
    let rest = &value[separator + 1..];
    if rest.len() < length {
        return None;
    }
    Some(DecodedPartId {
        item_id: &rest[..length],
        part_id: &rest[length..],
    })
}

/// 部件 id 是否属于给定对象。
pub(crate) fn belongs_to_item(value: &str, item_id: &str) -> bool {
    decode_part_id(value).is_some_and(|decoded| decoded.item_id == item_id)
}

/// 部件 id 的对象根（`partId` 为空）。
#[allow(dead_code)]
pub(crate) fn item_root_of(value: &str) -> Option<String> {
    let decoded = decode_part_id(value)?;
    Some(format!("{}:{}", decoded.item_id.len(), decoded.item_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_root_and_child_ids() {
        let root = encode_part_id("hero", "");
        let body = encode_part_id("hero", "body");
        assert_eq!(
            decode_part_id(&root),
            Some(DecodedPartId {
                item_id: "hero",
                part_id: ""
            })
        );
        assert_eq!(
            decode_part_id(&body),
            Some(DecodedPartId {
                item_id: "hero",
                part_id: "body"
            })
        );
        assert_eq!(item_root_of(&body).as_deref(), Some(root.as_str()));
        assert!(belongs_to_item(&body, "hero"));
        assert!(!belongs_to_item(&body, "villain"));
    }

    #[test]
    fn keeps_colons_inside_item_and_part_ids() {
        // 长度前缀让分隔符本身可以出现在 id 里，不做猜测式 split。
        let value = encode_part_id("a:b", "c:d");
        assert_eq!(
            decode_part_id(&value),
            Some(DecodedPartId {
                item_id: "a:b",
                part_id: "c:d"
            })
        );
    }

    #[test]
    fn rejects_malformed_encodings() {
        // `4:hero` 是合法的对象根编码（encode_part_id("hero", "")），不在此列。
        for value in ["", "hero", "x:hero", "-1:hero", "9:hero", "5:hero"] {
            assert!(decode_part_id(value).is_none(), "{value}");
        }
        assert_eq!(
            decode_part_id("4:hero"),
            Some(DecodedPartId {
                item_id: "hero",
                part_id: ""
            })
        );
    }
}
