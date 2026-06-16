# CosyVoice3 部署验证脚本：音色克隆 / 情感指令 / 拟声词
import sys
sys.path.append("/home/fuyujia/CosyVoice")
sys.path.append("/home/fuyujia/CosyVoice/third_party/Matcha-TTS")
from cosyvoice.cli.cosyvoice import AutoModel
import torchaudio

OUT = "/mnt/d/work/tts/output"
PROMPT_WAV = "/home/fuyujia/CosyVoice/asset/zero_shot_prompt.wav"

model = AutoModel(model_dir="/mnt/d/work/tts/pretrained_models/Fun-CosyVoice3-0.5B")

# 1. 零样本音色克隆
for i, j in enumerate(model.inference_zero_shot(
        "收到好友从远方寄来的生日礼物，那份意外的惊喜与深深的祝福让我心中充满了甜蜜的快乐，笑容如花儿般绽放。",
        "You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。",
        PROMPT_WAV, stream=False)):
    torchaudio.save(f"{OUT}/test1_zero_shot_{i}.wav", j["tts_speech"], model.sample_rate)
print("test1 zero-shot OK")

# 2. 情感指令控制
for i, j in enumerate(model.inference_instruct2(
        "今天真是太开心了，我们的项目终于上线了！",
        "You are a helpful assistant. 请用非常开心兴奋的语气说。<|endofprompt|>",
        PROMPT_WAV, stream=False)):
    torchaudio.save(f"{OUT}/test2_emotion_happy_{i}.wav", j["tts_speech"], model.sample_rate)
print("test2 emotion instruct OK")

# 3. 拟声词细粒度控制（笑声）
for i, j in enumerate(model.inference_cross_lingual(
        "You are a helpful assistant.<|endofprompt|>他讲到一半[laughter]自己先笑了出来[laughter]，大家也忍不住跟着笑了。",
        PROMPT_WAV, stream=False)):
    torchaudio.save(f"{OUT}/test3_laughter_{i}.wav", j["tts_speech"], model.sample_rate)
print("test3 fine-grained laughter OK")
print("ALL TESTS PASSED")
