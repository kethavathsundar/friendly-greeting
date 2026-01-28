import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

// Web search tool using Tavily
async function webSearch(query: string): Promise<string> {
  const tavilyKey = Deno.env.get("TAVILY_API_KEY");
  if (!tavilyKey) {
    return "Error: TAVILY_API_KEY not configured. Please add your Tavily API key to secrets.";
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavilyKey,
        query,
        search_depth: "basic",
        max_results: 5,
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status}`);
    }

    const data = await response.json();
    const results: TavilySearchResult[] = data.results || [];
    
    if (results.length === 0) {
      return "No search results found.";
    }

    return results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`)
      .join("\n\n");
  } catch (error) {
    return `Search error: ${error.message}`;
  }
}

// Tool definitions for OpenAI
const tools = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information. Use this when you need to find up-to-date information about any topic.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
        },
        required: ["query"],
      },
    },
  },
];

// Execute tool calls
async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "web_search":
      return await webSearch(args.query as string);
    default:
      return `Unknown tool: ${name}`;
  }
}

// Call OpenAI API
async function callOpenAI(messages: Message[], includeTools = true): Promise<{
  message: Message;
  finishReason: string;
}> {
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) {
    return {
      message: {
        role: "assistant",
        content: "Error: OPENAI_API_KEY not configured. Please add your OpenAI API key to secrets.",
      },
      finishReason: "stop",
    };
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls && { tool_calls: m.tool_calls }),
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
      })),
      ...(includeTools && { tools }),
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const choice = data.choices[0];
  
  return {
    message: {
      role: "assistant",
      content: choice.message.content || "",
      tool_calls: choice.message.tool_calls,
    },
    finishReason: choice.finish_reason,
  };
}

// LangGraph-style agent loop
async function runAgent(messages: Message[]): Promise<Message[]> {
  const systemMessage: Message = {
    role: "system",
    content: `You are a helpful AI assistant with access to web search. 
When users ask questions that require current information, use the web_search tool to find accurate, up-to-date answers.
Always cite your sources when providing information from search results.
Be concise but thorough in your responses.`,
  };

  const conversationMessages = [systemMessage, ...messages];
  const newMessages: Message[] = [];
  
  let iterations = 0;
  const maxIterations = 5;

  while (iterations < maxIterations) {
    iterations++;
    
    const { message, finishReason } = await callOpenAI(conversationMessages, true);
    
    // If no tool calls, we're done
    if (!message.tool_calls || message.tool_calls.length === 0) {
      newMessages.push(message);
      break;
    }

    // Add assistant message with tool calls
    newMessages.push(message);
    conversationMessages.push(message);

    // Execute each tool call
    for (const toolCall of message.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      const result = await executeTool(toolCall.function.name, args);
      
      const toolMessage: Message = {
        role: "tool",
        content: result,
        tool_call_id: toolCall.id,
      };
      
      newMessages.push(toolMessage);
      conversationMessages.push(toolMessage);
    }
  }

  return newMessages;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { conversationId, message } = await req.json();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let actualConversationId = conversationId;

    // Create new conversation if needed
    if (!actualConversationId) {
      const { data: conv, error: convError } = await supabase
        .from("conversations")
        .insert({ title: message.substring(0, 50) })
        .select()
        .single();
      
      if (convError) throw convError;
      actualConversationId = conv.id;
    }

    // Save user message
    const { error: userMsgError } = await supabase
      .from("messages")
      .insert({
        conversation_id: actualConversationId,
        role: "user",
        content: message,
      });
    
    if (userMsgError) throw userMsgError;

    // Get conversation history
    const { data: history, error: historyError } = await supabase
      .from("messages")
      .select("role, content, tool_calls, tool_call_id")
      .eq("conversation_id", actualConversationId)
      .order("created_at", { ascending: true });

    if (historyError) throw historyError;

    // Run agent
    const agentMessages = await runAgent(history as Message[]);

    // Save all new messages to database
    for (const msg of agentMessages) {
      await supabase.from("messages").insert({
        conversation_id: actualConversationId,
        role: msg.role,
        content: msg.content,
        tool_calls: msg.tool_calls || null,
        tool_call_id: msg.tool_call_id || null,
      });
    }

    // Get the final assistant response
    const assistantResponse = agentMessages.filter(m => m.role === "assistant").pop();

    return new Response(
      JSON.stringify({
        conversationId: actualConversationId,
        response: assistantResponse?.content || "I apologize, but I couldn't generate a response.",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Chat agent error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
