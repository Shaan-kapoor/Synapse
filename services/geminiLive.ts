import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';

// Tool definition for updating the graph
const updateGraphTool: FunctionDeclaration = {
  name: 'update_mind_map',
  description: 'Update the visual mind map with concepts and relationships extracted from speech.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      concepts: {
        type: Type.ARRAY,
        description: 'List of key concepts identified in the recent speech.',
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: 'Unique, canonical identifier (lowercase, snake_case). E.g. "artificial_intelligence" for "AI", "The Model", etc.' },
            label: { type: Type.STRING, description: 'Display label. Short phrase (2-5 words) that summarizes the idea. E.g. "Q4 Revenue Targets" instead of just "Revenue".' },
            importance: { type: Type.NUMBER, description: 'Relevance score 1-10. High score for main topics, low for details.' },
          },
          required: ['id', 'label', 'importance'],
        },
      },
      relationships: {
        type: Type.ARRAY,
        description: 'List of relationships between concepts.',
        items: {
          type: Type.OBJECT,
          properties: {
            source_id: { type: Type.STRING, description: 'ID of the source concept.' },
            target_id: { type: Type.STRING, description: 'ID of the target concept.' },
            strength: { type: Type.NUMBER, description: 'Strength of connection 1-5.' },
          },
          required: ['source_id', 'target_id', 'strength'],
        },
      },
    },
    required: ['concepts', 'relationships'],
  },
};

export class GeminiLiveService {
  private client: GoogleGenAI;
  private session: any | null = null;
  private inputAudioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private isConnected: boolean = false;
  
  // Audio Processing State
  private inputSampleRate: number = 0;
  private targetSampleRate: number = 16000;
  private bufferAccumulator: Float32Array = new Float32Array(0);
  private nextExpectedSampleIndex: number = 0;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async connect(
    onGraphUpdate: (data: any) => void,
    onTranscriptUpdate: (text: string) => void,
    onStatusChange: (status: string) => void
  ) {
    try {
      onStatusChange('connecting');

      // 1. Get Microphone Access first
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            } 
        });
      } catch (audioError) {
        console.error("Microphone permission denied:", audioError);
        throw new Error("Microphone access is required to use this app. Please enable it in your browser settings.");
      }

      // 2. Create AudioContext at NATIVE rate to avoid browser resampling artifacts
      this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.inputSampleRate = this.inputAudioContext.sampleRate;
      
      // Reset state
      this.nextExpectedSampleIndex = 0;
      this.bufferAccumulator = new Float32Array(0);

      const config = {
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            console.log('Gemini Live Session Opened');
            this.isConnected = true;
            onStatusChange('active');
          },
          onmessage: (message: LiveServerMessage) => {
            this.handleMessage(message, onGraphUpdate, onTranscriptUpdate);
          },
          onclose: () => {
            console.log('Gemini Live Session Closed');
            this.isConnected = false;
            onStatusChange('idle');
          },
          onerror: (err: any) => {
            console.error('Gemini Live Error:', err);
            this.isConnected = false;
            onStatusChange('error');
          },
        },
        config: {
          responseModalities: [Modality.AUDIO], 
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          // Enable input audio transcription (empty object is sufficient)
          // Specifying a model here can cause "Invalid Argument" errors
          inputAudioTranscription: {},
          tools: [{ functionDeclarations: [updateGraphTool] }],
          systemInstruction: `
            You are an expert Knowledge Graph Engineer and Listener.
            Your goal is to visualize the user's stream of consciousness as a coherent, interconnected mind map.
            
            **CORE BEHAVIORS:**
            1. **Concept Synthesis**: Do NOT map every single noun. Listen for complete thoughts and extract meaningful *phrases* (2-5 words).
               - Bad: "Marketing", "Plan", "Budget"
               - Good: "Marketing Strategy", "Q3 Budget Allocation"
            
            2. **Canonical Identity**: Recognize when the user talks about the same thing using different words.
               - If user says "The app", "This project", and "MindMap Live", use the SAME ID: \`mindmap_live\`.
               - This ensures the graph grows *denser* and *better* over time, rather than just spawning disconnected duplicates.

            3. **Hierarchy & Structure**: 
               - Identify the "Root Topic" early.
               - As the user dives into details, link new concepts back to their parent context.
               - Create a web of knowledge, not a line of dominoes.
            
            4. **Silence**: You do not speak. You only listen and update the graph.

            **WHEN TO EMIT:**
            - Emit updates whenever a new meaningful concept is introduced or a relationship is clarified.
            - If the user emphasizes a point, emit an update to boost its 'importance' score.
          `,
        },
      };

      // 3. Connect to Gemini Live
      this.session = await this.client.live.connect(config);
      
      // 4. Start Audio Stream
      this.startAudioStream();

    } catch (error) {
      console.error('Connection failed:', error);
      onStatusChange('error');
      this.disconnect();
      throw error;
    }
  }

  private startAudioStream() {
    if (!this.inputAudioContext || !this.stream || !this.session) return;

    if (this.inputAudioContext.state === 'suspended') {
      this.inputAudioContext.resume();
    }

    this.source = this.inputAudioContext.createMediaStreamSource(this.stream);
    this.processor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (!this.isConnected || !this.session) return;

      const inputData = e.inputBuffer.getChannelData(0);
      
      // Resample strictly to 16000Hz using stateful processing
      const resampledData = this.downsampleAndAccumulate(inputData);
      
      // Only send if we have enough data to be efficient (e.g. > 1024 samples)
      // This reduces network fragmentation
      if (resampledData.length > 0) {
        const b64Data = this.pcmToB64(resampledData);
        this.session.sendRealtimeInput({
          media: {
            mimeType: `audio/pcm;rate=${this.targetSampleRate}`,
            data: b64Data,
          },
        });
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.inputAudioContext.destination);
  }

  private downsampleAndAccumulate(inputBuffer: Float32Array): Float32Array {
    if (this.inputSampleRate === this.targetSampleRate) {
      return inputBuffer;
    }

    const ratio = this.inputSampleRate / this.targetSampleRate;
    const outputLength = Math.ceil((inputBuffer.length - this.nextExpectedSampleIndex) / ratio);
    const result = new Float32Array(outputLength);
    
    let outputIndex = 0;
    
    // We iterate "time" in input domain
    while (this.nextExpectedSampleIndex < inputBuffer.length) {
      const i = this.nextExpectedSampleIndex;
      const indexInt = Math.floor(i);
      
      if (indexInt < inputBuffer.length) {
        result[outputIndex] = inputBuffer[indexInt];
        outputIndex++;
      }
      
      this.nextExpectedSampleIndex += ratio;
    }

    this.nextExpectedSampleIndex -= inputBuffer.length;

    return result.slice(0, outputIndex);
  }

  private handleMessage(
    message: LiveServerMessage, 
    onGraphUpdate: (data: any) => void,
    onTranscriptUpdate: (text: string) => void
  ) {
    if (message.toolCall) {
      message.toolCall.functionCalls.forEach((fc) => {
        if (fc.name === 'update_mind_map') {
          onGraphUpdate(fc.args);
          if (this.session && this.isConnected) {
            this.session.sendToolResponse({
              functionResponses: {
                id: fc.id,
                name: fc.name,
                response: { result: 'ok' }, 
              },
            });
          }
        }
      });
    }

    if (message.serverContent?.inputTranscription) {
      const text = message.serverContent.inputTranscription.text;
      if (text && text.trim().length > 0) {
        onTranscriptUpdate(text);
      }
    }
  }

  disconnect() {
    this.isConnected = false;
    this.nextExpectedSampleIndex = 0;

    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null; 
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.inputAudioContext) {
      this.inputAudioContext.close().catch(e => console.error("Error closing audio context", e));
      this.inputAudioContext = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    this.session = null;
  }

  private pcmToB64(data: Float32Array): string {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      let s = Math.max(-1, Math.min(1, data[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    let binary = '';
    const bytes = new Uint8Array(int16.buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}