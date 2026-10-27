Put a 16 kHz mono 16-bit WAV here for the fake robot, e.g. `question.wav` ("What time is it?").
Record one on the Mac:  `say -o q.aiff "what time is it"` then `afconvert -f WAVE -d LEI16@16000 -c 1 q.aiff question.wav`.
