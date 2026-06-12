from pathlib import Path
import subprocess

print("=== whisper.cpp 진단 ===")

# 1. exe 확인
cpp_exe = Path(__file__).parent / "whisper-bin" / "whisper-cli.exe"
print(f"exe 경로: {cpp_exe}")
print(f"exe 존재: {cpp_exe.exists()}")

# 2. 모델 확인
model = Path(r"C:\whisper-models\ggml-small.bin")
print(f"모델 경로: {model}")
print(f"모델 존재: {model.exists()}")

# 3. 테스트 파일 확인
test_file = Path(r"C:\whisper-models\260512_1605.mp3")
print(f"테스트 파일 존재: {test_file.exists()}")

# 4. 실제 실행 테스트
if cpp_exe.exists() and model.exists() and test_file.exists():
    print("\n=== 실행 테스트 ===")
    cmd = [str(cpp_exe), "-m", str(model), "-f", str(test_file), "-l", "ko", "-pp", "-t", "4"]
    print(f"명령어: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(f"stdout 앞 500자:\n{result.stdout[:500]}")
    print(f"stderr 앞 500자:\n{result.stderr[:500]}")
else:
    print("파일이 없어서 실행 테스트 불가")
