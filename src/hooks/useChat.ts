import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  created_at: string;
}

interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
}

export function useChat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Fetch all conversations
  const fetchConversations = useCallback(async () => {
    const { data, error } = await supabase
      .from("conversations")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("Error fetching conversations:", error);
      return;
    }

    setConversations(data || []);
  }, []);

  // Fetch messages for active conversation
  const fetchMessages = useCallback(async (conversationId: string) => {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error fetching messages:", error);
      return;
    }

    // Filter to only show user and assistant messages in UI
    const visibleMessages = (data || [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant" | "tool",
        content: m.content,
        created_at: m.created_at,
      }));
    setMessages(visibleMessages);
  }, []);

  // Initial load
  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Load messages when active conversation changes
  useEffect(() => {
    if (activeConversationId) {
      fetchMessages(activeConversationId);
    } else {
      setMessages([]);
    }
  }, [activeConversationId, fetchMessages]);

  // Subscribe to realtime updates
  useEffect(() => {
    if (!activeConversationId) return;

    const channel = supabase
      .channel(`messages-${activeConversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${activeConversationId}`,
        },
        (payload) => {
          const newMessage = payload.new as Message;
          if (newMessage.role === "user" || newMessage.role === "assistant") {
            setMessages((prev) => {
              if (prev.some((m) => m.id === newMessage.id)) return prev;
              return [...prev, newMessage];
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeConversationId]);

  // Send message
  const sendMessage = async (content: string) => {
    setIsLoading(true);

    try {
      const response = await supabase.functions.invoke("chat-agent", {
        body: {
          conversationId: activeConversationId,
          message: content,
        },
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

      const { conversationId: newConversationId } = response.data;

      // If this was a new conversation, update state
      if (!activeConversationId && newConversationId) {
        setActiveConversationId(newConversationId);
        fetchConversations();
      }
    } catch (error) {
      console.error("Error sending message:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to send message",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Delete conversation
  const deleteConversation = async (id: string) => {
    const { error } = await supabase
      .from("conversations")
      .delete()
      .eq("id", id);

    if (error) {
      toast({
        title: "Error",
        description: "Failed to delete conversation",
        variant: "destructive",
      });
      return;
    }

    if (activeConversationId === id) {
      setActiveConversationId(null);
    }
    fetchConversations();
  };

  // Start new conversation
  const startNewConversation = () => {
    setActiveConversationId(null);
    setMessages([]);
  };

  return {
    conversations,
    activeConversationId,
    messages,
    isLoading,
    sendMessage,
    setActiveConversationId,
    deleteConversation,
    startNewConversation,
  };
}
