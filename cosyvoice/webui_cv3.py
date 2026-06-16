# CosyVoice3 适配版 WebUI（基于官方 webui.py 修改）
# 改动：去掉预训练音色模式（CV3 无内置音色）；自然语言控制改用 inference_instruct2；
#       自动补全 <|endofprompt|> 标记；预填示例参考音频，开箱即用。
import os
import sys
import argparse
import gradio as gr
import numpy as np
import torch
import torchaudio
import random
import librosa

ROOT_DIR = '/home/fuyujia/CosyVoice'
sys.path.append(ROOT_DIR)
sys.path.append('{}/third_party/Matcha-TTS'.format(ROOT_DIR))
from cosyvoice.cli.cosyvoice import AutoModel
from cosyvoice.utils.file_utils import logging
from cosyvoice.utils.common import set_all_random_seed

SYSTEM_PREFIX = 'You are a helpful assistant.<|endofprompt|>'
DEFAULT_PROMPT_WAV = '{}/asset/zero_shot_prompt.wav'.format(ROOT_DIR)
DEFAULT_PROMPT_TEXT = '希望你以后能够做的比我还好呦。'

inference_mode_list = ['3s极速复刻', '跨语种复刻', '自然语言控制']
instruct_dict = {
    '3s极速复刻': '1. 选择prompt音频文件（或用默认示例音频），不超过30s\n2. 输入prompt文本（音频的文字内容）\n3. 点击生成音频按钮',
    '跨语种复刻': '1. 选择prompt音频文件（或用默认示例音频）\n2. 合成文本中可加 [laughter] [breath] 等拟声标记\n3. 点击生成音频按钮',
    '自然语言控制': '1. 选择prompt音频文件作为音色参考\n2. 输入instruct文本，如：请用非常开心兴奋的语气说。/ 请用四川话说。\n3. 点击生成音频按钮'}
stream_mode_list = [('否', False), ('是', True)]
max_val = 0.8


def generate_seed():
    seed = random.randint(1, 100000000)
    return {
        "__type__": "update",
        "value": seed
    }


def change_instruction(mode_checkbox_group):
    return instruct_dict[mode_checkbox_group]


def ensure_system_prefix(text):
    if '<|endofprompt|>' not in text:
        return SYSTEM_PREFIX + text
    return text


def generate_audio(tts_text, mode_checkbox_group, prompt_text, prompt_wav_upload, prompt_wav_record, instruct_text,
                   seed, stream, speed):
    if prompt_wav_upload is not None:
        prompt_wav = prompt_wav_upload
    elif prompt_wav_record is not None:
        prompt_wav = prompt_wav_record
    else:
        prompt_wav = None
    if prompt_wav is None:
        gr.Warning('prompt音频为空，您是否忘记输入prompt音频？')
        yield (cosyvoice.sample_rate, default_data)
        return
    if torchaudio.info(prompt_wav).sample_rate < prompt_sr:
        gr.Warning('prompt音频采样率{}低于{}'.format(torchaudio.info(prompt_wav).sample_rate, prompt_sr))
        yield (cosyvoice.sample_rate, default_data)
        return
    if mode_checkbox_group == '自然语言控制':
        if instruct_text == '':
            gr.Warning('您正在使用自然语言控制模式, 请输入instruct文本')
            yield (cosyvoice.sample_rate, default_data)
            return
    if mode_checkbox_group == '3s极速复刻':
        if prompt_text == '':
            gr.Warning('prompt文本为空，您是否忘记输入prompt文本？')
            yield (cosyvoice.sample_rate, default_data)
            return

    set_all_random_seed(seed)
    if mode_checkbox_group == '3s极速复刻':
        logging.info('get zero_shot inference request')
        for i in cosyvoice.inference_zero_shot(tts_text, ensure_system_prefix(prompt_text), prompt_wav, stream=stream, speed=speed):
            yield (cosyvoice.sample_rate, i['tts_speech'].numpy().flatten())
    elif mode_checkbox_group == '跨语种复刻':
        logging.info('get cross_lingual inference request')
        for i in cosyvoice.inference_cross_lingual(ensure_system_prefix(tts_text), prompt_wav, stream=stream, speed=speed):
            yield (cosyvoice.sample_rate, i['tts_speech'].numpy().flatten())
    else:
        logging.info('get instruct2 inference request')
        instruct_full = instruct_text if instruct_text.endswith('<|endofprompt|>') else 'You are a helpful assistant. ' + instruct_text + '<|endofprompt|>'
        for i in cosyvoice.inference_instruct2(tts_text, instruct_full, prompt_wav, stream=stream, speed=speed):
            yield (cosyvoice.sample_rate, i['tts_speech'].numpy().flatten())


def main():
    with gr.Blocks() as demo:
        gr.Markdown("### CosyVoice3 本地合成（Fun-CosyVoice3-0.5B） \
                    [代码库](https://github.com/FunAudioLLM/CosyVoice) | 模型无内置音色，全部模式都基于参考音频克隆")
        gr.Markdown("#### 已预填示例参考音频，直接点击「生成音频」即可试听。换成自己的音频可克隆任意音色。")

        tts_text = gr.Textbox(label="输入合成文本", lines=1, value="我是通义实验室语音团队全新推出的生成式语音大模型，提供舒适自然的语音合成能力。")
        with gr.Row():
            mode_checkbox_group = gr.Radio(choices=inference_mode_list, label='选择推理模式', value=inference_mode_list[0])
            instruction_text = gr.Text(label="操作步骤", value=instruct_dict[inference_mode_list[0]], scale=0.5)
            stream = gr.Radio(choices=stream_mode_list, label='是否流式推理', value=stream_mode_list[0][1])
            speed = gr.Number(value=1, label="速度调节(仅支持非流式推理)", minimum=0.5, maximum=2.0, step=0.1)
            with gr.Column(scale=0.25):
                seed_button = gr.Button(value="\U0001F3B2")
                seed = gr.Number(value=0, label="随机推理种子")

        with gr.Row():
            prompt_wav_upload = gr.Audio(sources='upload', type='filepath', label='选择prompt音频文件，注意采样率不低于16khz', value=DEFAULT_PROMPT_WAV)
            prompt_wav_record = gr.Audio(sources='microphone', type='filepath', label='录制prompt音频文件')
        prompt_text = gr.Textbox(label="输入prompt文本（与prompt音频内容一致）", lines=1, value=DEFAULT_PROMPT_TEXT)
        instruct_text = gr.Textbox(label="输入instruct文本（自然语言控制模式用）", lines=1, placeholder="如：请用非常开心兴奋的语气说。/ 请用粤语说。/ 请用很快的语速说。", value='')

        generate_button = gr.Button("生成音频")

        audio_output = gr.Audio(label="合成音频", autoplay=True, streaming=True)

        seed_button.click(generate_seed, inputs=[], outputs=seed)
        generate_button.click(generate_audio,
                              inputs=[tts_text, mode_checkbox_group, prompt_text, prompt_wav_upload, prompt_wav_record, instruct_text,
                                      seed, stream, speed],
                              outputs=[audio_output])
        mode_checkbox_group.change(fn=change_instruction, inputs=[mode_checkbox_group], outputs=[instruction_text])
    demo.queue(max_size=4, default_concurrency_limit=2)
    demo.launch(server_name='0.0.0.0', server_port=args.port)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port',
                        type=int,
                        default=50000)
    parser.add_argument('--model_dir',
                        type=str,
                        default='/mnt/d/work/tts/pretrained_models/Fun-CosyVoice3-0.5B',
                        help='local path or modelscope repo id')
    args = parser.parse_args()
    cosyvoice = AutoModel(model_dir=args.model_dir)

    prompt_sr = 16000
    default_data = np.zeros(cosyvoice.sample_rate)
    main()
