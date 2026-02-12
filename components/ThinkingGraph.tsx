import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { GraphData, GraphNode, GraphLink, VisMode, HandCursor } from '../types';

interface ThinkingGraphProps {
  data: GraphData;
  zoomLevel?: number;
  mode: VisMode;
  cursor: HandCursor | null;
  focusedNodeId: string | null;
  onNodeHover: (nodeId: string | null) => void;
  onNodeDoubleClick: (nodeId: string) => void;
  onBackgroundClick?: () => void;
}

const ThinkingGraph: React.FC<ThinkingGraphProps> = ({ 
  data, 
  zoomLevel = 1, 
  mode, 
  cursor, 
  focusedNodeId, 
  onNodeHover,
  onNodeDoubleClick,
  onBackgroundClick
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);
  
  // Track visual focus for smooth transitions
  const [activeHoverId, setActiveHoverId] = useState<string | null>(null);

  // Hit Test Logic
  useEffect(() => {
    if (!cursor || !svgRef.current || data.nodes.length === 0) {
        if (activeHoverId) {
             setActiveHoverId(null);
             onNodeHover(null);
        }
        return;
    }
    
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    // Cursor x,y are already normalized (0-1) and corrected for mirroring in App.tsx
    const cursorX = cursor.x * width; 
    const cursorY = cursor.y * height;

    const centerX = width / 2;
    const centerY = height / 2;

    let hitNode: string | null = null;
    let minDist = 70; // Generous hit radius

    data.nodes.forEach(node => {
      if (node.x !== undefined && node.y !== undefined) {
        // Project node to screen space based on CURRENT zoom/focus transform
        // We approximation the transform based on props
        
        let tx = width / 2;
        let ty = height / 2;
        let k = zoomLevel;

        if (focusedNodeId) {
            const focusedNode = data.nodes.find(n => n.id === focusedNodeId);
            if (focusedNode && focusedNode.x !== undefined && focusedNode.y !== undefined) {
                const focusK = 1.2; // Reduced from 1.5 to 1.2 (User Request: "Zoom is too much")
                tx = width / 2 - (focusedNode.x * focusK);
                ty = height / 2 - (focusedNode.y * focusK);
                k = focusK;
            }
        }

        const screenNodeX = (node.x * k) + tx;
        const screenNodeY = (node.y * k) + ty;

        const dist = Math.sqrt(Math.pow(screenNodeX - cursorX, 2) + Math.pow(screenNodeY - cursorY, 2));
        
        if (dist < minDist) {
          hitNode = node.id;
          minDist = dist;
        }
      }
    });

    if (hitNode !== activeHoverId) {
      setActiveHoverId(hitNode);
      onNodeHover(hitNode);
    }

  }, [cursor, data.nodes, zoomLevel, activeHoverId, focusedNodeId]); 

  useEffect(() => {
    if (!svgRef.current) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    // Initialize Simulation if not exists
    if (!simulationRef.current) {
      simulationRef.current = d3.forceSimulation<GraphNode, GraphLink>()
        .force('link', d3.forceLink<GraphNode, GraphLink>().id((d: any) => d.id))
        .force('charge', d3.forceManyBody())
        .force('collide', d3.forceCollide())
        .force('x', d3.forceX())
        .force('y', d3.forceY());
    }

    const svg = d3.select(svgRef.current);
    const container = svg.select('.graph-container');
    const simulation = simulationRef.current;

    simulation.nodes(data.nodes);

    // Setup Background Layers
    const bgLayer = container.select('.bg-layer');
    bgLayer.selectAll('*').remove(); 

    if (mode === 'layers') {
      const layers = [
        { label: 'CORE CONCEPTS', y: height * 0.15, color: 'rgba(239, 68, 68, 0.05)' },
        { label: 'SUPPORTING IDEAS', y: height * 0.5, color: 'rgba(255, 255, 255, 0.02)' },
        { label: 'DETAILS', y: height * 0.85, color: 'rgba(255, 255, 255, 0.05)' }
      ];

      bgLayer.selectAll('rect')
        .data(layers)
        .enter().append('rect')
        .attr('x', -width)
        .attr('y', (d, i) => (i * height / 3) - height/2)
        .attr('width', width * 3)
        .attr('height', height / 3)
        .attr('fill', d => d.color);

      bgLayer.selectAll('text')
        .data(layers)
        .enter().append('text')
        .attr('x', -width/2 + 40)
        .attr('y', (d, i) => (i * height / 3) - height/2 + 30)
        .text(d => d.label)
        .attr('fill', 'rgba(255,255,255,0.2)')
        .style('font-family', 'monospace')
        .style('letter-spacing', '0.2em');
    }

    // Configure Forces
    simulation.force('center', null);
    simulation.force('radial', null);

    const chargeStrength = focusedNodeId ? -800 : -500; 

    if (mode === 'network') {
      simulation
        .force('link', d3.forceLink<GraphNode, GraphLink>().id((d: any) => d.id).distance(focusedNodeId ? 200 : 150).links(data.links))
        .force('charge', d3.forceManyBody().strength(chargeStrength))
        .force('collide', d3.forceCollide().radius((d: any) => Math.max(30, d.val * 4)))
        .force('x', d3.forceX(0).strength(0.05))
        .force('y', d3.forceY(0).strength(0.05));
    } else if (mode === 'stream') {
        const nodeCount = data.nodes.length || 1;
        simulation
            .force('link', d3.forceLink<GraphNode, GraphLink>().id((d: any) => d.id).distance(80).strength(0.5).links(data.links))
            .force('charge', d3.forceManyBody().strength(-100))
            .force('collide', d3.forceCollide().radius(30))
            .force('x', d3.forceX((d: any, i) => {
                const progress = i / (nodeCount - 1 || 1);
                return -width/2.5 + (progress * width * 0.8);
            }).strength(2))
            .force('y', d3.forceY(0).strength(0.3));
    } else if (mode === 'layers') {
        simulation
            .force('link', d3.forceLink<GraphNode, GraphLink>().id((d: any) => d.id).distance(100).strength(0.1).links(data.links))
            .force('charge', d3.forceManyBody().strength(-200))
            .force('collide', d3.forceCollide().radius(40))
            .force('x', d3.forceX(0).strength(0.05))
            .force('y', d3.forceY((d: any) => {
                const importance = Math.min(10, Math.max(1, d.val));
                if (importance > 7) return -height/3 + 50; 
                if (importance > 4) return 0;
                return height/3 - 50;
            }).strength(1.5));
    } else if (mode === 'cluster') {
        simulation
            .force('link', d3.forceLink<GraphNode, GraphLink>().id((d: any) => d.id).distance(30).strength(0.01).links(data.links))
            .force('charge', d3.forceManyBody().strength(-10))
            .force('collide', d3.forceCollide().radius((d: any) => d.val * 4 + 15).strength(0.9))
            .force('x', d3.forceX(0).strength(0.2))
            .force('y', d3.forceY(0).strength(0.2));
    }

    // Render Links
    const linksLayer = container.select('.links-layer');
    const links = linksLayer.selectAll<SVGPathElement, GraphLink>('path')
      .data(data.links, (d: any) => `${d.source.id || d.source}-${d.target.id || d.target}`);

    const linksEnter = links.enter().append('path')
      .attr('stroke', 'white')
      .attr('fill', 'none')
      .attr('stroke-width', 1)
      .attr('opacity', 0);

    links.merge(linksEnter).transition().duration(500)
      .attr('opacity', (d: any) => {
         if (focusedNodeId) {
             if (d.source.id === focusedNodeId || d.target.id === focusedNodeId) return 0.6;
             return 0.1;
         }
         return mode === 'cluster' ? 0 : (mode === 'network' ? 0.4 : 0.2)
      })
      .attr('stroke-width', (d) => Math.max(1, d.value));

    links.exit().remove();

    // Render Nodes
    const nodesLayer = container.select('.nodes-layer');
    const nodes = nodesLayer.selectAll<SVGGElement, GraphNode>('g')
      .data(data.nodes, (d) => d.id);

    const nodesEnter = nodes.enter().append('g')
      .attr('class', 'node')
      .call(d3.drag<SVGGElement, GraphNode>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended) as any)
      .on('click', (event) => {
        // Prevent background click from firing when clicking a node
        event.stopPropagation();
      })
      .on('dblclick', (event, d) => {
        event.stopPropagation();
        onNodeDoubleClick(d.id);
      });

    nodesEnter.append('circle')
      .attr('r', 0);

    nodesEnter.append('text')
      .attr('dy', 5)
      .attr('text-anchor', 'middle')
      .text((d) => d.label)
      .attr('fill', 'white')
      .style('pointer-events', 'none')
      .style('opacity', 0);

    // Update Nodes Style
    const mergedNodes = nodes.merge(nodesEnter);

    mergedNodes.select('circle')
      .transition().duration(500)
      .attr('r', (d) => {
        if (focusedNodeId) {
           if (d.id === focusedNodeId) return Math.max(30, d.val * 2.5); // Reduced from 40 / 3
           return Math.max(10, d.val * 1.5); 
        }

        if (activeHoverId === d.id) return Math.max(25, d.val * 3 + 10); 
        
        if (mode === 'cluster') return Math.max(20, d.val * 5);
        if (mode === 'stream') return 8;
        return Math.max(15, d.val * 3);
      })
      .attr('fill', (d) => {
        if (focusedNodeId && d.id === focusedNodeId) return 'rgba(239, 68, 68, 0.8)';
        if (activeHoverId === d.id) return 'rgba(255, 255, 255, 0.4)';

        if (mode === 'cluster') return 'rgba(255, 255, 255, 0.2)';
        if (mode === 'stream') return 'rgba(255, 255, 255, 0.9)';
        if (mode === 'layers') {
           return d.val > 7 ? 'rgba(239, 68, 68, 0.8)' : (d.val > 4 ? 'rgba(255, 165, 0, 0.5)' : 'rgba(255, 255, 255, 0.2)');
        }
        return d.val > 15 ? 'rgba(239, 68, 68, 0.4)' : 'rgba(255, 255, 255, 0.1)';
      })
      .attr('stroke', (d) => {
        if (focusedNodeId && d.id === focusedNodeId) return 'white';
        if (activeHoverId === d.id) return 'white';
        if (mode === 'cluster') return 'none';
        return d.val > 15 ? 'rgba(239, 68, 68, 0.8)' : 'rgba(255, 255, 255, 0.6)';
      })
      .attr('stroke-width', (d) => (d.id === focusedNodeId || d.id === activeHoverId) ? 3 : 1);
    
    mergedNodes.select('text')
      .text((d) => d.label)
      .transition().duration(500)
      .style('opacity', (d) => {
        if (focusedNodeId && d.id !== focusedNodeId) return 0.2; 
        return 1;
      })
      .style('font-size', (d) => {
        if (d.id === focusedNodeId) return '24px'; 
        if (mode === 'stream') return '10px';
        return `${Math.max(10, Math.min(24, 10 + d.val/1.5))}px`;
      })
      .attr('dy', mode === 'stream' ? 20 : 5);

    nodes.exit().transition().duration(300).style('opacity', 0).remove();

    simulation.alpha(1).restart();

    simulation.on('tick', () => {
      linksEnter.merge(links).attr('d', (d: any) => {
        const sourceX = d.source.x;
        const sourceY = d.source.y;
        const targetX = d.target.x;
        const targetY = d.target.y;

        if (mode === 'stream') {
          const dist = Math.abs(targetX - sourceX) * 0.5;
          return `M${sourceX},${sourceY} C${sourceX + dist},${sourceY} ${targetX - dist},${targetY} ${targetX},${targetY}`;
        } else {
          return `M${sourceX},${sourceY} L${targetX},${targetY}`;
        }
      });

      mergedNodes.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
    });

    function dragstarted(event: any, d: any) {
      if (!event.active) simulation?.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(event: any, d: any) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragended(event: any, d: any) {
      if (!event.active) simulation?.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }

    return () => {
      simulation.stop();
    };
  }, [data, mode, focusedNodeId, activeHoverId]); 

  // Handle Zoom & Focus Pan
  useEffect(() => {
    if (svgRef.current) {
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        let transform;
        
        if (focusedNodeId) {
            const node = data.nodes.find(n => n.id === focusedNodeId);
            if (node && node.x !== undefined && node.y !== undefined) {
                 // Adjusted Zoom Factor for Focus
                 const k = 1.2; // Reduced from 1.5
                 const tx = width/2 - (node.x * k);
                 const ty = height/2 - (node.y * k);
                 transform = `translate(${tx}, ${ty}) scale(${k})`;
            } else {
                 transform = `translate(${width/2}, ${height/2}) scale(${zoomLevel})`;
            }
        } else {
            transform = `translate(${width/2}, ${height/2}) scale(${zoomLevel})`;
        }

        d3.select(svgRef.current).select('.graph-container')
            .transition()
            .duration(750)
            .ease(d3.easeCubicOut)
            .attr('transform', transform);
    }
  }, [zoomLevel, focusedNodeId, data.nodes]);

  return (
    <>
        <svg 
        ref={svgRef} 
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: 'all' }}
        onClick={onBackgroundClick}
        onDoubleClick={onBackgroundClick}
        >
        <g className="graph-container">
            <g className="bg-layer"></g>
            <g className="links-layer"></g>
            <g className="nodes-layer"></g>
        </g>
        </svg>

        {/* Render Hand Cursor */}
        {cursor && (
            <div 
                className="absolute pointer-events-none transition-transform duration-75 z-50"
                style={{ 
                    left: 0, 
                    top: 0, 
                    transform: `translate(${cursor.x * window.innerWidth}px, ${cursor.y * window.innerHeight}px)` 
                }}
            >
                {/* Cursor Dot */}
                <div className={`
                    w-6 h-6 -ml-3 -mt-3 rounded-full border-2 shadow-[0_0_20px_rgba(255,255,255,0.8)]
                    ${cursor.isPinching
                        ? 'bg-blue-500 border-blue-200 scale-125' 
                        : activeHoverId 
                                ? 'bg-green-400 border-green-200' 
                                : 'bg-white/50 border-white'
                    }
                    transition-all duration-200
                `}></div>
                
                {/* Action Label */}
                {cursor.isPinching && (
                    <div className="absolute top-8 left-1/2 -translate-x-1/2 text-xs font-bold uppercase tracking-wider text-white px-3 py-1 rounded-full backdrop-blur-md shadow-lg bg-blue-500/80">
                        Select
                    </div>
                )}
            </div>
        )}
    </>
  );
};

export default ThinkingGraph;