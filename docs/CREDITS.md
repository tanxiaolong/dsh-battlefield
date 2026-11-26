# 素材出处与授权 / Audio credits

本插件里所有的声音**都是 CC0（公有领域）**，代码是 MIT。像素层面没有第三方素材——键盘、直方图、进度条全部是 CSS。

## 代码

MIT，见 [LICENSE](../LICENSE)。

## 声音（全部 CC0）

| 用途 | 源文件（本插件里切出的样本名） | 原始作品 | 作者 | 授权 |
|---|---|---|---|---|
| 主层炮声 / 近失弹 / 撞船 / 重炮 / 远景 | `cannon_fire.ogg`、`cannon_hit.ogg`、`cannon_hit_cannon.ogg`、`cannon_hit_ship_short.ogg`、`cannon_hit_wall.ogg`、`cannon_hit_wall_no_splash.ogg`、`cannon_miss.ogg`、`ship_destroyed_short.ogg`、`ship_ram_ship.ogg`、`ship_ram_ship_shortened.ogg`<br>→ `blast-*` `wall-*` `miss-*` `ram-*` `heavy-*` `far-*` `long-*` `boom-*` | [Battle at sea](https://opengameart.org/content/battle-at-sea) | Thimras | CC0 |
| 远景爆炸 | `explosion_somewhere_far.mp3`<br>→ `far-*` `long-10` `boom-4` | [Explosion somewhere far](https://opengameart.org/content/explosion-somewhere-far) | pauliuw | CC0 |
| 空袭警报（氛围层） | `160888__blaukreuz__air-raid.wav`<br>→ `siren-1.ogg` | [air-raid](https://freesound.org/s/160888/) | blaukreuz | CC0 |
| B-25 起飞掠过（氛围层） | `329616__loveburd__b-25-takeoff-01.wav`<br>→ `plane-1.ogg` | [B-25 takeoff](https://freesound.org/s/329616/) | loveburd | CC0 |
| 电台通话（氛围层） | `855900__qubodup__military-air-strike-radio-chatter.ogg`<br>→ `radio-1.ogg` | [Military air strike radio chatter](https://freesound.org/s/855900/) | qubodup | CC0 |
| 回车应答「roger that」 | `roger_that.mp3`<br>→ `roger-1.ogg` | [Voice Male Radio Roger That](https://freesound.org/people/qubodup/sounds/67662/) | qubodup | CC0 |

CC0 不要求署名，这里署名是出于尊重。若某段素材的授权判断有误，请联系后立即替换——所有样本都可以用 `tools/build-sfx.py` 一键重建。

## 处理方式

原始文件都没有直接打包：脚本 `tools/build-sfx.py` 把它们切成 47 段单发样本（48kHz / 24kHz、归一化到 −1 dBFS、Vorbis 编码），再 base64 内联进 `client.js`。切成单发是因为原始录音是连续齐射（`cannon_hit.ogg` 4.94 秒内 21 响），整段播会变成按一下响五秒。
